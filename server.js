const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();

// Список активных SSE-соединений для real-time обновлений
let sseClients = [];

// Кэш для защиты от спама: хранит временную метку последней отправки задания по IP
const taskRateLimitMap = new Map();
let submissionsEnabled = true;
let buttonMode = 'task'; // 'task', 'punishment' или 'modifier'
let keepAliveConfig = {
    enabled: true,              // Главный переключатель
    useSchedule: false,         // Использовать ли расписание
    mode: 'active_between',     // 'active_between' (работать от и до) или 'sleep_between' (спать/отключаться от и до)
    startTime: '08:00',         // Время начала (ЧЧ:ММ)
    endTime: '23:00',           // Время окончания (ЧЧ:ММ)
    timezone: 'Europe/Moscow'   // Часовой пояс
};

let lastKeepAliveTime = null;
let detectedBaseUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || null;

// Проверка активности анти-сна в текущую минуту с учетом расписания
function isKeepAliveActiveNow() {
    if (!keepAliveConfig.enabled) return false;
    if (!keepAliveConfig.useSchedule) return true;

    let nowHours, nowMinutes;
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: keepAliveConfig.timezone || 'Europe/Moscow',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).formatToParts(new Date());
        nowHours = parseInt(parts.find(p => p.type === 'hour').value, 10);
        nowMinutes = parseInt(parts.find(p => p.type === 'minute').value, 10);
    } catch (e) {
        const now = new Date();
        nowHours = now.getHours();
        nowMinutes = now.getMinutes();
    }

    const currentTotalMin = nowHours * 60 + nowMinutes;
    const [startH, startM] = (keepAliveConfig.startTime || '00:00').split(':').map(Number);
    const [endH, endM] = (keepAliveConfig.endTime || '23:59').split(':').map(Number);
    const startTotalMin = startH * 60 + startM;
    const endTotalMin = endH * 60 + endM;

    // Проверка интервала (поддерживает переход через полночь, например с 23:00 до 07:00)
    let inInterval = false;
    if (startTotalMin <= endTotalMin) {
        inInterval = currentTotalMin >= startTotalMin && currentTotalMin < endTotalMin;
    } else {
        inInterval = currentTotalMin >= startTotalMin || currentTotalMin < endTotalMin;
    }

    // Если режим 'sleep_between' — в интервале спим (выключен), вне интервала активны
    if (keepAliveConfig.mode === 'sleep_between') {
        return !inInterval;
    }
    // Если режим 'active_between' — активны строго внутри интервала
    return inInterval;
}

// Имитация активности (HTTP-запрос самому себе)
async function pingSelf() {
    if (!isKeepAliveActiveNow()) {
        console.log(`[Keep-Alive] ⏸️ Пинг пропущен (отключен или спит по расписанию: ${new Date().toLocaleTimeString('ru-RU')})`);
        return;
    }
    const targetUrl = detectedBaseUrl || `http://localhost:${PORT}`;
    try {
        await fetch(`${targetUrl}/api/ping`);
        lastKeepAliveTime = new Date().toISOString();
        console.log(`[Keep-Alive] 🟢 Сервер успешно пинганул себя: ${targetUrl}/api/ping (${new Date().toLocaleTimeString('ru-RU')})`);
    } catch (e) {
        console.error('[Keep-Alive] 🔴 Ошибка пинга:', e.message);
    }
}

// Запуск пинга каждые 10 минут (600 000 мс)
setInterval(pingSelf, 10 * 60 * 1000);
const MAX_ATTEMPTS = 2;              // Максимальный запас попыток
const SOFT_COOLDOWN_MS = 15 * 1000;  // Мягкая пауза между попытками (15 секунд)
const HARD_COOLDOWN_MS = 60 * 1000;  // Жесткий кулдаун (1 минута)

// Периодическая очистка устаревших записей из памяти (каждые 5 минут)
setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of taskRateLimitMap.entries()) {
        const isExpired = (now - data.lastSentTime > HARD_COOLDOWN_MS) && (!data.blockedUntil || now > data.blockedUntil);
        if (isExpired) {
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
// Автоматически запоминаем публичный URL сайта от первого вошедшего пользователя
app.use((req, res, next) => {
    if (!detectedBaseUrl && req.get('host')) {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
        detectedBaseUrl = `${protocol}://${req.get('host')}`;
    }
    next();
});

// Легкий эндпоинт для самопинга
app.get('/api/ping', (req, res) => res.send('pong'));
app.get('/api/submissions-status', (req, res) => {
    res.json({ enabled: submissionsEnabled, mode: buttonMode });
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Сохранение и загрузка глобальных настроек из Supabase (с контролем успешности и повторными попытками)
async function saveSettings() {
    try {
        const payload = {
            key: 'main',
            value: {
                submissionsEnabled,
                buttonMode,
                keepAliveConfig
            },
            updated_at: new Date().toISOString()
        };
        const { error } = await supabase.from('app_settings').upsert(payload, { onConflict: 'key' });
        if (error) {
            console.error('❌ Ошибка сохранения настроек в Supabase:', error.message);
            return false;
        }
        console.log('💾 Настройки успешно сохранены в Supabase:', { submissionsEnabled, buttonMode });
        return true;
    } catch (e) {
        console.error('❌ Исключение при сохранении настроек:', e.message);
        return false;
    }
}

async function loadSettingsFromDb(retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const { data, error } = await supabase.from('app_settings').select('value').eq('key', 'main').maybeSingle();
            if (error) {
                console.warn(`⚠️ [Попытка ${attempt}/${retries}] Ошибка чтения настроек из Supabase:`, error.message);
                if (attempt < retries) {
                    await new Promise(res => setTimeout(res, 1000));
                    continue;
                }
                return;
            }
            if (data && data.value) {
                if (typeof data.value.submissionsEnabled !== 'undefined') submissionsEnabled = Boolean(data.value.submissionsEnabled);
                if (data.value.buttonMode) buttonMode = data.value.buttonMode;
                if (data.value.keepAliveConfig) keepAliveConfig = { ...keepAliveConfig, ...data.value.keepAliveConfig };
                console.log('✅ Настройки админки успешно восстановлены из Supabase:', { submissionsEnabled, buttonMode });
            } else {
                console.log('ℹ️ Настройки в Supabase еще не созданы. Выполняем первичную запись...');
                await saveSettings();
            }
            return;
        } catch (e) {
            console.warn(`⚠️ [Попытка ${attempt}/${retries}] Исключение при загрузке настроек:`, e.message);
            if (attempt < retries) await new Promise(res => setTimeout(res, 1000));
        }
    }
}

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
    const { text, type, parent_id } = req.body;
    let taskType = 'task';
    const effectiveType = type || buttonMode;
    if (effectiveType === 'punishment') taskType = 'punishment';
    else if (effectiveType === 'modifier') taskType = 'modifier';
    if (!submissionsEnabled) {
        return res.status(403).json({ error: 'Приём заданий временно приостановлен' });
    }
    if (!text || text.trim().length === 0) {
        return res.status(400).json({ error: 'Текст задания не может быть пустым' });
    }

    const ip = getClientIp(req);

    // Проверка на чёрный список
    const { data: banned } = await supabase.from('banned_ips').select('id').eq('ip', ip).maybeSingle();
    if (banned) {
        return res.status(403).json({ error: 'Ваш IP находится в чёрном списке' });
    }

    // Проверка лимита и попыток по IP
    const now = Date.now();
    let rateData = taskRateLimitMap.get(ip);

    // Сброс баланса до 2 попыток, если кулдаун закончился
    if (rateData) {
        if (rateData.blockedUntil && now >= rateData.blockedUntil) {
            rateData = null;
            taskRateLimitMap.delete(ip);
        } else if (now - rateData.lastSentTime >= HARD_COOLDOWN_MS) {
            rateData = null;
            taskRateLimitMap.delete(ip);
        }
    }

    if (!rateData) {
        rateData = { attempts: MAX_ATTEMPTS, lastSentTime: 0, blockedUntil: 0 };
    }

    // 1. Проверка жесткого кулдауна
    if (rateData.blockedUntil && rateData.blockedUntil > now) {
        const timeLeftSec = Math.ceil((rateData.blockedUntil - now) / 1000);
        return res.status(429).json({
            error: `Попытки исчерпаны. Подождите ещё ${timeLeftSec} сек.`,
            retryAfter: timeLeftSec
        });
    }

    // 2. Проверка мягкой паузы (15 секунд между 1-й и 2-й попыткой)
    if (rateData.attempts < MAX_ATTEMPTS) {
        const elapsed = now - rateData.lastSentTime;
        if (elapsed < SOFT_COOLDOWN_MS) {
            // Нарушение спам-фильтра: обнуляем баланс и активируем жесткий бан на 1 минуту
            rateData.attempts = 0;
            rateData.blockedUntil = now + HARD_COOLDOWN_MS;
            taskRateLimitMap.set(ip, rateData);

            const penaltySec = Math.ceil(HARD_COOLDOWN_MS / 1000);
            return res.status(429).json({
                error: `Слишком частая отправка! Блокировка на ${penaltySec} сек.`,
                retryAfter: penaltySec
            });
        }
    }

    let parsedParentId = parent_id ? Number(parent_id) : null;

    // Если создается усложнение и родитель не выбран вручную — выбираем случайный
    if (taskType === 'modifier' && !parsedParentId) {
        try {
            const { data: randomCandidates } = await supabase
                .from('tasks')
                .select('id')
                .or('type.eq.punishment,is_favorite.eq.true')
                .limit(50);

            if (randomCandidates && randomCandidates.length > 0) {
                const randomItem = randomCandidates[Math.floor(Math.random() * randomCandidates.length)];
                parsedParentId = randomItem.id;
            }
        } catch (e) {
            console.warn('Не удалось выбрать случайного родителя:', e.message);
        }
    }

    const { data: inserted, error } = await supabase.from('tasks').insert([
        { text: text.trim(), ip: ip, likes_count: 0, reports_count: 0, type: taskType, parent_id: parsedParentId }
    ]).select().single();

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    // Подтягиваем данные родительского задания при наличии
    let parentData = null;
    if (parsedParentId) {
        const { data: p } = await supabase.from('tasks').select('id, text, type').eq('id', parsedParentId).maybeSingle();
        parentData = p || null;
    }

    // Списываем 1 попытку
    rateData.attempts -= 1;
    rateData.lastSentTime = Date.now();

    // Если потрачены обе попытки — включаем жесткий кулдаун на 1 минуту
    if (rateData.attempts <= 0) {
        rateData.blockedUntil = rateData.lastSentTime + HARD_COOLDOWN_MS;
    }
    taskRateLimitMap.set(ip, rateData);

    // Оповещаем всех подключенных пользователей о новом задании
    broadcastFeedEvent('new_task', {
        id: inserted.id,
        text: inserted.text,
        created_at: inserted.created_at,
        likes_count: inserted.likes_count,
        reports_count: inserted.reports_count,
        type: inserted.type || taskType,
        parent_id: inserted.parent_id,
        parent: parentData
    });

    res.json({ 
        success: true, 
        task: inserted, 
        attemptsLeft: rateData.attempts,
        blockedUntil: rateData.blockedUntil
    });
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
    const sort = req.query.sort || 'new'; // 'new', 'top' или 'favorite'
    const itemType = req.query.type || 'task'; // 'task', 'punishment' или 'modifier'
    const ip = getClientIp(req);

    let query = supabase.from('tasks').select('id, text, created_at, likes_count, reports_count, type, parent_id, is_favorite');

    // Фильтр "Избранные" доступен только для заданий
    if (itemType === 'task' && sort === 'favorite') {
        query = query.eq('is_favorite', true);
    }

    if (itemType === 'punishment') {
        query = query.eq('type', 'punishment');
    } else if (itemType === 'modifier') {
        query = query.eq('type', 'modifier');
    } else {
        query = query.or('type.eq.task,type.is.null');
    }

    if (sort === 'top') {
        query = query.order('likes_count', { ascending: false }).order('created_at', { ascending: false });
    } else {
        query = query.order('created_at', { ascending: false });
    }

    const { data: tasks, error } = await query.limit(100);
    if (error) return res.status(500).json({ error: error.message });

    // Если запрошены усложнения, собираем информацию об их родителях
    let parentMap = new Map();
    const parentIds = [...new Set((tasks || []).map(t => t.parent_id).filter(Boolean))];
    if (parentIds.length > 0) {
        const { data: parents } = await supabase.from('tasks').select('id, text, type').in('id', parentIds);
        (parents || []).forEach(p => parentMap.set(p.id, p));
    }

    // Получаем список ID, за которые данный IP уже голосовал или жаловался
    const { data: userVotes } = await supabase.from('task_votes').select('task_id').eq('ip', ip);
    const { data: userReports } = await supabase.from('task_reports').select('task_id').eq('ip', ip);

    const votedIds = new Set((userVotes || []).map(v => v.task_id));
    const reportedIds = new Set((userReports || []).map(r => r.task_id));

    const enrichedTasks = tasks.map(t => ({
        ...t,
        parent: t.parent_id ? (parentMap.get(t.parent_id) || null) : null,
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
    const itemType = req.query.type || buttonMode || 'task';
    let query = supabase.from('tasks').select('text').order('created_at', { ascending: false }).limit(50);
    
    if (itemType === 'punishment') {
        query = query.eq('type', 'punishment');
    } else if (itemType === 'modifier') {
        query = query.eq('type', 'modifier');
    } else {
        query = query.or('type.eq.task,type.is.null');
    }

    const { data, error } = await query;

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 1.1.1 Список для выбора при усложнении: наказания (все) + задания (только избранные)
app.get('/api/available-parents', async (req, res) => {
    const { data, error } = await supabase
        .from('tasks')
        .select('id, text, type, likes_count, is_favorite')
        .or('type.eq.punishment,is_favorite.eq.true')
        .order('likes_count', { ascending: false })
        .limit(100);

    if (error) return res.status(500).json({ error: error.message });

    // Оставляем все наказания, а из обычных заданий пропускаем только избранные
    const filtered = (data || []).filter(item => {
        if (item.type === 'punishment') return true;
        if ((!item.type || item.type === 'task') && item.is_favorite) return true;
        return false;
    });

    res.json(filtered);
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

// Добавление задания/наказания вручную администратором
app.post('/api/admin/tasks', authMiddleware, async (req, res) => {
    const { text, type, parent_id } = req.body;
    let itemType = 'task';
    if (type === 'punishment') itemType = 'punishment';
    else if (type === 'modifier') itemType = 'modifier';
    if (!text || text.trim().length === 0) {
        return res.status(400).json({ error: 'Текст не может быть пустым' });
    }

    const parsedParent = parent_id ? Number(parent_id) : null;
    const { data: inserted, error } = await supabase.from('tasks').insert([
        { text: text.trim(), ip: 'Администратор', likes_count: 0, reports_count: 0, type: itemType, parent_id: parsedParent }
    ]).select().single();

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    // Рассылаем всем открытым вкладкам новое задание/наказание
    broadcastFeedEvent('new_task', {
        id: inserted.id,
        text: inserted.text,
        created_at: inserted.created_at,
        likes_count: inserted.likes_count,
        reports_count: inserted.reports_count,
        type: inserted.type
    });

    res.json({ success: true, task: inserted });
});

// Переключение и получение режима кнопки (Задания / Наказания)
app.get('/api/admin/mode', authMiddleware, (req, res) => {
    res.json({ mode: buttonMode });
});

app.post('/api/admin/mode', authMiddleware, async (req, res) => {
    const { mode } = req.body;
    if (mode === 'task' || mode === 'punishment' || mode === 'modifier') {
        buttonMode = mode;
        const saved = await saveSettings();
        if (!saved) {
            return res.status(500).json({ error: 'Не удалось сохранить режим в базе Supabase' });
        }
        broadcastFeedEvent('mode_toggle', { mode: buttonMode });
    }
    res.json({ success: true, mode: buttonMode });
});

// Переключение и получение статуса кнопки приёма заданий (админ)
app.get('/api/admin/submissions-status', authMiddleware, (req, res) => {
    res.json({ enabled: submissionsEnabled });
});

app.post('/api/admin/submissions-toggle', authMiddleware, async (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'undefined') {
        submissionsEnabled = Boolean(enabled);
        const saved = await saveSettings();
        if (!saved) {
            return res.status(500).json({ error: 'Не удалось сохранить статус кнопки в базе Supabase' });
        }
        broadcastFeedEvent('submissions_toggle', { enabled: submissionsEnabled });
    }
    res.json({ success: true, enabled: submissionsEnabled });
});

// 3. Получение списка заданий (только для админа)
app.get('/api/tasks', authMiddleware, async (req, res) => {
    const { data, error } = await supabase
        .from('tasks')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 3.1 Переключение статуса "Избранное" у задания (только для админа)
app.post('/api/admin/tasks/:id/toggle-favorite', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { data: task, error: fetchErr } = await supabase
        .from('tasks')
        .select('id, is_favorite')
        .eq('id', id)
        .single();

    if (fetchErr || !task) return res.status(404).json({ error: 'Задание не найдено' });

    const newFavoriteStatus = !task.is_favorite;
    const { error: updateErr } = await supabase
        .from('tasks')
        .update({ is_favorite: newFavoriteStatus })
        .eq('id', id);

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    broadcastFeedEvent('favorite_update', { id: Number(id), is_favorite: newFavoriteStatus });
    res.json({ success: true, is_favorite: newFavoriteStatus });
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

// 9. Получить статус и конфигурацию Анти-сна (только для админа)
app.get('/api/admin/keepalive', authMiddleware, (req, res) => {
    res.json({
        ...keepAliveConfig,
        isActiveNow: isKeepAliveActiveNow(),
        lastPing: lastKeepAliveTime,
        url: detectedBaseUrl
    });
});

// 10. Обновить статус / расписание Анти-сна (только для админа)
app.post('/api/admin/keepalive', authMiddleware, async (req, res) => {
    const { enabled, useSchedule, mode, startTime, endTime, timezone } = req.body;

    if (typeof enabled !== 'undefined') keepAliveConfig.enabled = Boolean(enabled);
    if (typeof useSchedule !== 'undefined') keepAliveConfig.useSchedule = Boolean(useSchedule);
    if (mode) keepAliveConfig.mode = mode;
    if (startTime) keepAliveConfig.startTime = startTime;
    if (endTime) keepAliveConfig.endTime = endTime;
    if (timezone) keepAliveConfig.timezone = timezone;

    await saveSettings();

    if (isKeepAliveActiveNow()) {
        pingSelf();
    }

    res.json({
        success: true,
        config: keepAliveConfig,
        isActiveNow: isKeepAliveActiveNow()
    });
});

const PORT = process.env.PORT || 3000;
// Загружаем настройки из БД ДО того, как сервер начнёт принимать запросы
(async () => {
    await loadSettingsFromDb();
    app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
})();