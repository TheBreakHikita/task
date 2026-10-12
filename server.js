const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();

// Список активных SSE-соединений для real-time обновлений
let sseClients = [];

// Кэш для защиты от спама: хранит временную метку последней отправки задания по IP
const taskRateLimitMap = new Map();
const TASK_COOLDOWN_MS = 60 * 1000; // Задержка 1 минута

// Периодическая очистка устаревших записей из памяти (каждые 5 минут)
setInterval(() => {
    const now = Date.now();
    for (const [ip, lastTime] of taskRateLimitMap.entries()) {
        if (now - lastTime > TASK_COOLDOWN_MS) {
            taskRateLimitMap.delete(ip);
        }
    }
}, 5 * 60 * 1000);

function broadcastFeedEvent(type, payload) {
    const data = JSON.stringify({ type, payload });
    sseClients.forEach(client => {
        try {
            client.res.write(`data: ${data}\n\n`);
        } catch (e) {}
    });
}

function generateAuthToken(password) {
    return crypto.createHash('sha256').update(password + 'task_salt_secret').digest('hex');
}

// Включаем доверие прокси (для Render, Vercel, Railway, чтобы видеть реальный IP посетителя)
app.set('trust proxy', true);

app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Вспомогательная функция извлечения чистого IP
function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    let ip = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
    if (ip && ip.startsWith('::ffff:')) {
        ip = ip.replace('::ffff:', '');
    }
    return ip || 'Неизвестен';
}

// 1. Отправка нового задания пользователем
app.post('/api/tasks', async (req, res) => {
    const { text } = req.body;
    if (!text || text.trim().length === 0) {
        return res.status(400).json({ error: 'Текст задания не может быть пустым' });
    }

    const ip = getClientIp(req);

    // Проверка на чёрный список
    const { data: banned } = await supabase.from('banned_ips').select('id').eq('ip', ip).maybeSingle();
    if (banned) {
        return res.status(403).json({ error: 'Ваш IP находится в чёрном списке' });
    }

    // Проверка лимита по IP (кулдаун 1 минута)
    const now = Date.now();
    const lastSentTime = taskRateLimitMap.get(ip);
    if (lastSentTime && now - lastSentTime < TASK_COOLDOWN_MS) {
        const timeLeftSec = Math.ceil((TASK_COOLDOWN_MS - (now - lastSentTime)) / 1000);
        return res.status(429).json({
            error: `Подождите ещё ${timeLeftSec} сек. перед отправкой следующего задания.`,
            retryAfter: timeLeftSec
        });
    }

    const { data: inserted, error } = await supabase.from('tasks').insert([
        { text: text.trim(), ip: ip, likes_count: 0, reports_count: 0 }
    ]).select().single();

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    // Оповещаем всех подключенных пользователей о новом задании
    taskRateLimitMap.set(ip, Date.now());
    broadcastFeedEvent('new_task', {
        id: inserted.id,
        text: inserted.text,
        created_at: inserted.created_at,
        likes_count: inserted.likes_count,
        reports_count: inserted.reports_count
    });

    res.json({ success: true, task: inserted });
});

// Real-time поток событий для ленты (Server-Sent Events)
app.get('/api/feed-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const clientId = Date.now() + Math.random();
    const newClient = { id: clientId, res };
    sseClients.push(newClient);

    // Пинг каждые 25 сек для поддержания соединения через прокси
    const keepAlive = setInterval(() => {
        res.write(': keep-alive\n\n');
    }, 25000);

    req.on('close', () => {
        clearInterval(keepAlive);
        sseClients = sseClients.filter(c => c.id !== clientId);
    });
});

// 1.2 Публичная лента заданий с сортировкой и статусами пользователя
app.get('/api/feed-tasks', async (req, res) => {
    const sort = req.query.sort || 'new'; // 'new' или 'top'
    const ip = getClientIp(req);

    let query = supabase.from('tasks').select('id, text, created_at, likes_count, reports_count');

    if (sort === 'top') {
        query = query.order('likes_count', { ascending: false }).order('created_at', { ascending: false });
    } else {
        query = query.order('created_at', { ascending: false });
    }

    const { data: tasks, error } = await query.limit(100);
    if (error) return res.status(500).json({ error: error.message });

    // Получаем список ID, за которые данный IP уже голосовал или жаловался
    const { data: userVotes } = await supabase.from('task_votes').select('task_id').eq('ip', ip);
    const { data: userReports } = await supabase.from('task_reports').select('task_id').eq('ip', ip);

    const votedIds = new Set((userVotes || []).map(v => v.task_id));
    const reportedIds = new Set((userReports || []).map(r => r.task_id));

    const enrichedTasks = tasks.map(t => ({
        ...t,
        hasVoted: votedIds.has(t.id),
        hasReported: reportedIds.has(t.id)
    }));

    res.json(enrichedTasks);
});

// 1.3 Поставить / убрать лайк (тоггл)
app.post('/api/tasks/:id/vote', async (req, res) => {
    const taskId = req.params.id;
    const ip = getClientIp(req);

    // Проверяем, есть ли уже голос
    const { data: existingVote } = await supabase
        .from('task_votes')
        .select('id')
        .eq('task_id', taskId)
        .eq('ip', ip)
        .maybeSingle();

    if (existingVote) {
        // Убираем голос
        await supabase.from('task_votes').delete().eq('id', existingVote.id);
        const { data: task } = await supabase.from('tasks').select('likes_count').eq('id', taskId).single();
        const newCount = Math.max(0, (task?.likes_count || 1) - 1);
        await supabase.from('tasks').update({ likes_count: newCount }).eq('id', taskId);
        broadcastFeedEvent('vote_update', { id: Number(taskId), likes_count: newCount });
        return res.json({ success: true, hasVoted: false, likes_count: newCount });
    } else {
        // Ставим голос
        const { error: insertErr } = await supabase.from('task_votes').insert([{ task_id: taskId, ip }]);
        if (insertErr) return res.status(400).json({ error: insertErr.message });

        const { data: task } = await supabase.from('tasks').select('likes_count').eq('id', taskId).single();
        const newCount = (task?.likes_count || 0) + 1;
        await supabase.from('tasks').update({ likes_count: newCount }).eq('id', taskId);
        broadcastFeedEvent('vote_update', { id: Number(taskId), likes_count: newCount });
        return res.json({ success: true, hasVoted: true, likes_count: newCount });
    }
});

// 1.4 Отправить жалобу
app.post('/api/tasks/:id/report', async (req, res) => {
    const taskId = req.params.id;
    const ip = getClientIp(req);

    // Проверяем, жаловался ли уже данный IP
    const { data: existingReport } = await supabase
        .from('task_reports')
        .select('id')
        .eq('task_id', taskId)
        .eq('ip', ip)
        .maybeSingle();

    if (existingReport) {
        return res.status(400).json({ error: 'Вы уже отправили жалобу на это задание' });
    }

    const { error: insertErr } = await supabase.from('task_reports').insert([{ task_id: taskId, ip }]);
    if (insertErr) return res.status(400).json({ error: insertErr.message });

    const { data: task } = await supabase.from('tasks').select('reports_count').eq('id', taskId).single();
    const newCount = (task?.reports_count || 0) + 1;
    await supabase.from('tasks').update({ reports_count: newCount }).eq('id', taskId);

    broadcastFeedEvent('report_update', { id: Number(taskId), reports_count: newCount });
    res.json({ success: true, hasReported: true, reports_count: newCount });
});

// 1.1 Публичный список текстов для фона (без IP-адресов)
app.get('/api/public-tasks', async (req, res) => {
    const { data, error } = await supabase
        .from('tasks')
        .select('text')
        .order('created_at', { ascending: false })
        .limit(50);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 2. Вход для админа
app.post('/api/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        const token = generateAuthToken(ADMIN_PASSWORD);
        res.json({ success: true, token });
    } else {
        res.status(403).json({ error: 'Неверный пароль' });
    }
});

// Middleware проверки прав админа (токен сверяется без сброса памяти)
function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    const validToken = generateAuthToken(ADMIN_PASSWORD);
    if (!token || token !== validToken) {
        return res.status(401).json({ error: 'Не авторизован' });
    }
    next();
}

// 3. Получение списка заданий (только для админа)
app.get('/api/tasks', authMiddleware, async (req, res) => {
    const { data, error } = await supabase
        .from('tasks')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 4. Удаление задания (только для админа)
app.delete('/api/tasks/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { error } = await supabase.from('tasks').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    broadcastFeedEvent('task_deleted', { id: Number(id) });
    res.json({ success: true });
});

// 5. Получение заданий с жалобами (только для админа)
app.get('/api/admin/reports', authMiddleware, async (req, res) => {
    const { data, error } = await supabase
        .from('tasks')
        .select('*')
        .gt('reports_count', 0)
        .order('reports_count', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 5.1 Обнуление жалоб на задании (только для админа)
app.post('/api/admin/tasks/:id/reset-reports', authMiddleware, async (req, res) => {
    const { id } = req.params;

    // Сбрасываем счетчик жалоб задания в ноль
    const { error: updateErr } = await supabase
        .from('tasks')
        .update({ reports_count: 0 })
        .eq('id', id);

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // Удаляем записи о жалобах из связующей таблицы
    await supabase.from('task_reports').delete().eq('task_id', id);

    res.json({ success: true });
});

// 6. Получение списка забаненных IP
app.get('/api/admin/blacklist', authMiddleware, async (req, res) => {
    const { data, error } = await supabase.from('banned_ips').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 7. Добавление IP в черный список
app.post('/api/admin/blacklist', authMiddleware, async (req, res) => {
    const { ip, reason } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP обязателен' });

    const { error } = await supabase.from('banned_ips').upsert([{ ip: ip.trim(), reason: reason || 'Нарушение правил' }]);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// 8. Удаление IP из черного списка
app.delete('/api/admin/blacklist/:ip', authMiddleware, async (req, res) => {
    const { ip } = req.params;
    const { error } = await supabase.from('banned_ips').delete().eq('ip', ip);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));