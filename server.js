const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
const authTokens = new Set();

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

    const { error } = await supabase.from('tasks').insert([
        { text: text.trim(), ip: ip }
    ]);

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
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
        const token = crypto.randomBytes(16).toString('hex');
        authTokens.add(token);
        res.json({ success: true, token });
    } else {
        res.status(403).json({ error: 'Неверный пароль' });
    }
});

// Middleware проверки прав админа
function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token || !authTokens.has(token)) {
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
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));