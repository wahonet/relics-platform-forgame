// 跨模块共享的可变状态。
let allRelics = [], filtered = [];
let entityMap = {}, polygonEntities = [];
let activeCats = new Set();
let currentPhotos = [], currentDrawings = [];
let lbItems = [], lbIdx = 0;
let activeGroup = 'category_main';
let statFilters = {};
let dimColorMaps = {};

let _hdMode = (function () {
    try { return localStorage.getItem('hdMode') === '1'; } catch (e) { return false; }
})();
