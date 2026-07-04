// 三维模型查看器:通过 iframe 承载 /model-viewer,避免污染主 Cesium 场景。
function open3DBox(folder, name, refLat, refLng, refAlt) {
    const box = document.getElementById('model3dBox');
    document.getElementById('m3dTitle').textContent = name + ' — 三维模型';

    const old = document.getElementById('model3dFrame');
    if (old) old.remove();

    let url = '/model-viewer?folder=' + encodeURIComponent(folder) + '&name=' + encodeURIComponent(name);
    if (refLat && refLng) url += '&rlat=' + refLat + '&rlng=' + refLng + '&ralt=' + (refAlt || 0);

    const iframe = document.createElement('iframe');
    iframe.id = 'model3dFrame';
    iframe.src = url;
    box.appendChild(iframe);
    box.classList.add('open');

    viewer.useDefaultRenderLoop = false;
}

function close3DBox() {
    const box = document.getElementById('model3dBox');
    box.classList.remove('open');

    const iframe = document.getElementById('model3dFrame');
    if (iframe) {
        iframe.src = 'about:blank';
        setTimeout(() => iframe.remove(), 100);
    }

    viewer.useDefaultRenderLoop = true;
}

window.addEventListener('message', e => {
    if (e.data && e.data.type === 'm3d') {
        if (e.data.status === 'loaded') {
            toast(e.data.name + ' 三维模型加载成功');
        } else if (e.data.status === 'error') {
            toast(e.data.name + ' 三维模型加载失败', true);
        }
    }
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('model3dBox').classList.contains('open')) close3DBox();
});
