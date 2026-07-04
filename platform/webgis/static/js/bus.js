// 轻量事件总线,挂在 window.Bus 上,供 <script> 标签方式直接使用。
//
// 约定事件:
//   filter:changed     筛选条件变更,payload = { filters }
//   viewport:changed   视口变更,      payload = { bbox }
//   relic:selected     文物点击,      payload = relic
//   layer:toggled      图层开关,      payload = { id, visible }
//   chat:toggled       聊天面板开关,  payload = { open }
//
// 用法:
//   Bus.on('filter:changed', fn);
//   Bus.emit('filter:changed', { filters });
//   Bus.off('filter:changed', fn);
(function () {
    const _listeners = new Map();

    function on(event, fn) {
        if (!_listeners.has(event)) _listeners.set(event, new Set());
        _listeners.get(event).add(fn);
        return () => off(event, fn);
    }

    function off(event, fn) {
        const set = _listeners.get(event);
        if (set) set.delete(fn);
    }

    function emit(event, payload) {
        const set = _listeners.get(event);
        if (!set || set.size === 0) return;
        // 拷贝一份再遍历,允许订阅方在回调中 on/off 不影响当前派发。
        [...set].forEach((fn) => {
            try { fn(payload); } catch (e) { console.error('[Bus]', event, e); }
        });
    }

    function once(event, fn) {
        const wrap = (p) => { off(event, wrap); fn(p); };
        on(event, wrap);
    }

    window.Bus = { on, off, emit, once };
})();
