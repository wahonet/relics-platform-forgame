// 前端常量与统计维度定义。CENTER 来自后端注入的 __PLATFORM_CONFIG,缺省时回退示例县。
const API = '';
const _PC = window.__PLATFORM_CONFIG || {};
const _PC_CENTER = (_PC.geo && _PC.geo.center) || {};
const CENTER = {
    lng: _PC_CENTER.lng != null ? _PC_CENTER.lng : 116.3426,
    lat: _PC_CENTER.lat != null ? _PC_CENTER.lat : 35.4075,
    h: _PC_CENTER.alt != null ? _PC_CENTER.alt : 75000,
};
const DEF_COLOR = '#8b949e';
const COND_CLS = {'好':'lv-g','较好':'lv-f','一般':'lv-a','较差':'lv-p','差':'lv-p'};
const PALETTE = ['#f85149','#d29922','#3fb950','#58a6ff','#bc8cff','#ff7b72','#ffa657','#7ee787','#79c0ff','#a5d6ff','#d2a8ff','#ffd700','#56d4dd','#f778ba','#c9d1d9'];

const ERA_MAP = {
    '清代':'清','明代':'明','民国':'民国','近现代':'现代',
    '宋金辽元':'宋元','宋金元':'宋元',
    '战国至两汉':'战汉','战汉':'战汉',
    '隋唐':'隋唐','隋唐五代':'隋唐','隋唐（五代）':'隋唐',
    '两晋南北朝':'两晋南北朝','魏晋南北朝':'两晋南北朝',
    '新石器时代':'先秦','先秦':'先秦','商周':'先秦',
};
const ERA_ORDER = ['先秦','战汉','两晋南北朝','隋唐','宋元','明','清','民国','现代'];

const DIMS = [
    { id:'category_main', label:'文物类别', field:'category_main', transform: v => v === '近现代重要史迹及代表性建筑' ? '近现代史迹' : v },
    { id:'township', label:'乡镇分布', field:'township', transform: v => v.replace(/^\d+/, '') },
    { id:'era', label:'年代分布', field:'era_stats', remap: v => { for(const [k,mv] of Object.entries(ERA_MAP)) { if(v && v.includes(k)) return mv; } return v||'未知'; }, order: ERA_ORDER },
    { id:'heritage_level', label:'文物级别', field:'heritage_level', transform: v => (v==='尚未核定公布为文物保护单位的不可移动文物'||v==='未认定')?'未核定':v },
    { id:'survey_type', label:'普查类型', field:'survey_type' },
    { id:'ownership_type', label:'所有权', field:'ownership_type' },
    { id:'industry', label:'所属行业', field:'industry', transform: v => { const m=v?v.replace(/[,，、]/g,',').split(',')[0].trim():''; return m||'其他'; } },
    { id:'condition_level', label:'评估状态', field:'condition_level', order:['好','较好','一般','较差','差'] },
    { id:'risk_factors', label:'影响因素', field:'risk_factors', multi:true },
];

function dimValue(r, dim) {
    let v = r[dim.field] || '';
    if (dim.remap) return dim.remap(v);
    if (dim.transform) return dim.transform(v);
    return v || '未知';
}

function dimValues(r, dim) {
    if (!dim.multi) return [dimValue(r, dim)];
    const raw = r[dim.field] || '';
    const parts = raw.replace(/[,，]/g, '、').split('、').map(s=>s.trim()).filter(Boolean);
    return parts.length ? parts : ['未知'];
}
