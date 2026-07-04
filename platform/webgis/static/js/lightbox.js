// 照片 / 图纸灯箱:左右方向键切换,ESC 关闭。
function openPhotoLB(idx) {
    lbItems = currentPhotos.map(p => ({
        src: '/photos/' + p.relative_path,
        cap: (p.description || '') + (p.direction ? ' (' + p.direction + ')' : '')
    }));
    lbIdx = idx; updLB(); document.getElementById('lightbox').classList.add('open');
}

function openDrawingLB(idx) {
    lbItems = currentDrawings.map(d => ({
        src: '/drawings/' + d.relative_path,
        cap: d.drawing_no || d.drawing_name || '图纸'
    }));
    lbIdx = idx; updLB(); document.getElementById('lightbox').classList.add('open');
}

function closeLB() { document.getElementById('lightbox').classList.remove('open'); }

function navLB(d) { lbIdx = (lbIdx + d + lbItems.length) % lbItems.length; updLB(); }

function updLB() {
    const it = lbItems[lbIdx];
    document.getElementById('lbImg').src = it.src;
    document.getElementById('lbCap').textContent = it.cap + ' — ' + (lbIdx + 1) + '/' + lbItems.length;
}

document.addEventListener('keydown', e => {
    if (!document.getElementById('lightbox').classList.contains('open')) return;
    if (e.key === 'Escape') closeLB(); if (e.key === 'ArrowLeft') navLB(-1); if (e.key === 'ArrowRight') navLB(1);
});
