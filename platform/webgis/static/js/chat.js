// AI 问答面板:与 /api/chat 流式对接,消息中的 [[label|action]] 触发地图联动。
let chatHistory = [];
let chatStreaming = false;

(function loadModels() {
    fetch(API + '/api/chat/models').then(r => r.json()).then(data => {
        const sel = document.getElementById('chatModel');
        if (!sel || !data.models) return;
        sel.innerHTML = '';
        data.models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.name;
            if (m.id === data.default) opt.selected = true;
            sel.appendChild(opt);
        });
    }).catch(() => {});
})();

function getSelectedModel() {
    const sel = document.getElementById('chatModel');
    return sel ? sel.value : '';
}

function _aiGreeting() {
    const pc = window.__PLATFORM_CONFIG || {};
    const county = (pc.administrative && pc.administrative.county_name) || '本县';
    const total = (pc.stats && pc.stats.relics_total) || 0;
    const totalStr = total > 0 ? ('**' + total + '处**') : '';
    return '你好！我是' + county + '文物档案 AI 助手，我掌握着全部 '
        + totalStr + ' 文物的完整数据，以及完整的 **外业普查工作日志**。\n\n'
        + '试试问我：\n'
        + '- ' + county + '有哪些全国重点文物保护单位？\n'
        + '- 有哪些文物保存状况较差需要修缮？\n'
        + '- 各乡镇文物分布情况如何？\n'
        + '- 近期外业工作去了哪些地方？\n\n'
        + '回答中带 📍 的链接可直接在地图上查看，带 📋 的链接可打开工作日志！';
}

function toggleChat() {
    const panel = document.getElementById('chatPanel');
    const btn = document.getElementById('chatBtn');
    const open = panel.classList.toggle('open');
    btn.classList.toggle('on', open);
    if (open) {
        document.getElementById('chatInput').focus();
        if (!document.getElementById('chatMessages').children.length) {
            appendMsg('ai', _aiGreeting());
        }
    }
    if (window.Bus) window.Bus.emit('chat:toggled', { open });
}

// 轻量 Markdown 渲染;额外把 [[label|action]] 渲染为地图 / 日志联动链接。
function renderMd(text) {
    let h = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    h = h.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, function(_, label, action) {
        const a = action.replace(/&amp;/g, '&').replace(/'/g, "\\'");
        const isLog = a.startsWith('log:');
        const icon = isLog ? ' 📋' : ' 📍';
        const tip = isLog ? '查看工作日志' : '在地图上查看';
        return '<a class="cf' + (isLog ? ' cf-log' : '') + '" onclick="chatAction(\'' + a + '\')" title="' + tip + '">' + label + icon + '</a>';
    });

    h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    h = h.replace(/^####\s+(.+)$/gm, '<h5>$1</h5>');
    h = h.replace(/^###\s+(.+)$/gm, '<h4>$1</h4>');
    h = h.replace(/^##\s+(.+)$/gm, '<h4>$1</h4>');
    h = h.replace(/^#\s+(.+)$/gm, '<h4>$1</h4>');
    h = h.replace(/^---+$/gm, '<hr>');
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');

    const lines = h.split('\n');
    let out = [], inList = false, listType = '';
    for (let i = 0; i < lines.length; i++) {
        const li = lines[i];
        const ulMatch = li.match(/^[\-·•]\s+(.+)/);
        const olMatch = li.match(/^(\d+)[\.、]\s*(.+)/);
        if (ulMatch) {
            if (!inList || listType !== 'ul') { if (inList) out.push('</' + listType + '>'); out.push('<ul>'); inList = true; listType = 'ul'; }
            out.push('<li>' + ulMatch[1] + '</li>');
        } else if (olMatch) {
            if (!inList || listType !== 'ol') { if (inList) out.push('</' + listType + '>'); out.push('<ol>'); inList = true; listType = 'ol'; }
            out.push('<li>' + olMatch[2] + '</li>');
        } else {
            if (inList) { out.push('</' + listType + '>'); inList = false; }
            out.push(li);
        }
    }
    if (inList) out.push('</' + listType + '>');

    h = out.join('\n');
    h = h.replace(/\n/g, '<br>');
    h = h.replace(/<br>(<\/?(?:ul|ol|li|h[345]|hr))/g, '$1');
    h = h.replace(/(<\/(?:ul|ol|li|h[345]|hr)>)<br>/g, '$1');
    h = h.replace(/(<(?:ul|ol|hr)[^>]*>)<br>/g, '$1');
    return h;
}

function escapeHtml(t) {
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

function appendMsg(role, text) {
    const box = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = 'cm cm-' + role;
    div.innerHTML = '<div class="cm-bubble">' + renderMd(text) + '</div>';
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
}

// 聊天链接分发：fly:code 飞到文物；log:date 打开当天日志；其余按筛选串处理。
function chatAction(actionStr) {
    if (actionStr.startsWith('fly:')) {
        const code = actionStr.slice(4);
        flyTo(code);
        return;
    }
    if (actionStr.startsWith('log:')) {
        const date = actionStr.slice(4);
        openWorklogViewer(date);
        return;
    }
    chatFilter(actionStr);
}

function chatFilter(filterStr) {
    const params = {};
    filterStr.split('&').forEach(p => {
        const idx = p.indexOf(':');
        if (idx > 0) params[p.slice(0, idx).trim()] = p.slice(idx + 1).trim();
    });

    const result = allRelics.filter(r => {
        if (params.t) {
            const twn = (r.township || '').replace(/^\d+/, '');
            if (!twn.includes(params.t)) return false;
        }
        if (params.l) {
            if (!(r.heritage_level || '').includes(params.l)) return false;
        }
        if (params.c) {
            if (r.category_main !== params.c) return false;
        }
        if (params.s) {
            if (r.condition_level !== params.s) return false;
        }
        if (params['3d'] === '1' && !is3D(r)) return false;
        if (params.kw) {
            const kw = params.kw.toLowerCase();
            if (!r.name.toLowerCase().includes(kw) && !(r.address || '').toLowerCase().includes(kw)) return false;
        }
        return true;
    });

    filtered = result;
    document.getElementById('tbCount').textContent = filtered.length;
    dimColorMaps[activeGroup] = buildColorMap(allRelics, DIMS.find(d => d.id === activeGroup));
    renderPoints(filtered);
    renderAllCharts(filtered);
    updateLegend();

    if (filtered.length > 0) fitToRelics(filtered);

    showChatResults(result, params);
    toast('已在地图上显示 ' + filtered.length + ' 处文物');
}

function showChatResults(relics, params) {
    const panel = document.getElementById('chatResults');
    const titleEl = document.getElementById('crTitle');
    const listEl = document.getElementById('crList');

    let title = '';
    if (params.t) title += params.t;
    if (params.c) title += (title ? ' · ' : '') + params.c;
    if (params.l) title += (title ? ' · ' : '') + params.l;
    if (params.s) title += (title ? ' · ' : '') + '现状' + params.s;
    if (params['3d']) title += (title ? ' · ' : '') + '三维模型';
    if (params.kw) title += (title ? ' · ' : '') + '"' + params.kw + '"';
    titleEl.textContent = (title || '筛选结果') + '（' + relics.length + '处）';

    listEl.innerHTML = relics.slice(0, 100).map(r =>
        '<div class="cr-item" onclick="flyTo(\'' + r.archive_code + '\')">' +
        '<div class="cr-name">' + r.name + (is3D(r) ? '<span class="cr-3d">3D</span>' : '') + '</div>' +
        '<div class="cr-meta"><span class="cr-cat">' + (r.category_main || '') + '</span><span class="cr-era">' + (r.era || '') + '</span><span>' + (r.township || '').replace(/^\d+/, '') + '</span></div>' +
        '</div>'
    ).join('');

    panel.classList.add('open');
}

function closeChatResults() {
    document.getElementById('chatResults').classList.remove('open');
}

async function sendChat() {
    if (chatStreaming) return;
    const input = document.getElementById('chatInput');
    const msg = input.value.trim();
    if (!msg) return;

    input.value = '';
    appendMsg('user', msg);

    chatStreaming = true;
    const sendBtn = document.getElementById('chatSend');
    sendBtn.disabled = true;
    sendBtn.textContent = '...';

    const model = getSelectedModel();
    const aiDiv = appendMsg('ai', '');
    const bubble = aiDiv.querySelector('.cm-bubble');
    bubble.innerHTML = '<span class="cm-typing">正在查询文物数据库...</span>';

    let fullText = '';
    try {
        const resp = await fetch(API + '/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, history: chatHistory.slice(-10), model: model }),
        });

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6);
                if (payload === '[DONE]') continue;
                try {
                    const data = JSON.parse(payload);
                    if (data.error) {
                        fullText += '\n[错误] ' + data.error;
                    } else if (data.content) {
                        fullText += data.content;
                    }
                    bubble.innerHTML = escapeHtml(fullText) + '<span class="cm-cursor"></span>';
                    aiDiv.parentElement.scrollTop = aiDiv.parentElement.scrollHeight;
                } catch (e) {}
            }
        }
    } catch (e) {
        fullText = '网络请求失败，请检查后端服务是否正常运行。';
    }

    bubble.innerHTML = renderMd(fullText || '(无回复)');
    chatHistory.push({ role: 'user', content: msg });
    chatHistory.push({ role: 'assistant', content: fullText });

    chatStreaming = false;
    sendBtn.disabled = false;
    sendBtn.textContent = '发送';
}

function clearChat() {
    chatHistory = [];
    document.getElementById('chatMessages').innerHTML = '';
    appendMsg('ai', '对话已清空，请继续提问。');
}

document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && document.getElementById('chatPanel').classList.contains('open')) {
        if (document.activeElement === document.getElementById('chatInput')) {
            e.preventDefault();
            sendChat();
        }
    }
});
