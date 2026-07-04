// 国标 / 四普编码字典(前端)。与后端 `platform/scripts/codes.py` 保持同步。
//
// CATEGORY_MAP   文物大类,code = 4 位编码,对应 DB 的 relics.category
// RANK_MAP       保护级别,code = "1".."5",size 决定符号大小
// SEARCH_TYPE_MAP 普查来源(三普 / 县级以上 / 四普新增)
//
// 颜色与旧 PALETTE 视觉一致:前 6 个色相依次对应 6 大类。
(function () {
    const CATEGORY_MAP = {
        '0100': { label: '古遗址',                         color: '#f85149', icon: '/static/古文化遗址.png' },
        '0200': { label: '古墓葬',                         color: '#d29922', icon: '/static/古墓葬.png' },
        '0300': { label: '古建筑',                         color: '#3fb950', icon: '/static/古建筑.png' },
        '0400': { label: '石窟寺及石刻',                   color: '#58a6ff', icon: '/static/石窟寺及石刻.png' },
        '0500': { label: '近现代重要史迹及代表性建筑',      color: '#bc8cff', icon: '/static/近现代重要史迹及代表性建筑.png' },
        '0600': { label: '其他',                           color: '#8b949e', icon: null },
    };

    const RANK_MAP = {
        '1': { label: '全国重点文物保护单位', short: '国保', size: 14, prominent: true  },
        '2': { label: '省级文物保护单位',     short: '省保', size: 12, prominent: true  },
        '3': { label: '市级文物保护单位',     short: '市保', size: 11, prominent: false },
        '4': { label: '县级文物保护单位',     short: '县保', size: 10, prominent: false },
        '5': { label: '尚未核定公布为文物保护单位的不可移动文物', short: '未定级', size: 9, prominent: false },
    };

    const SEARCH_TYPE_MAP = {
        '2':      { label: '三普在册'     },
        '12':     { label: '县级以上公布' },
        '110301': { label: '四普新增'     },
    };

    // 中文 → 编码反向表,把老前端传入的中文统一映射到编码。
    const CATEGORY_ALIAS = {
        '古遗址': '0100', '古文化遗址': '0100',
        '古墓葬': '0200',
        '古建筑': '0300',
        '石窟寺及石刻': '0400',
        '近现代重要史迹及代表性建筑': '0500', '近现代史迹': '0500',
        '其他': '0600',
    };

    const RANK_ALIAS = {
        '全国重点文物保护单位': '1',
        '省级文物保护单位': '2',
        '市级文物保护单位': '3',
        '县级文物保护单位': '4',
        '尚未核定公布为文物保护单位的不可移动文物': '5',
        '未核定': '5', '未认定': '5', '未定级': '5',
    };

    function categoryCode(value) {
        if (!value) return '0600';
        const v = String(value).trim();
        if (CATEGORY_MAP[v]) return v;
        return CATEGORY_ALIAS[v] || '0600';
    }

    function rankCode(value) {
        if (!value) return '5';
        const v = String(value).trim();
        if (RANK_MAP[v]) return v;
        return RANK_ALIAS[v] || '5';
    }

    function categoryLabel(code)     { return (CATEGORY_MAP[code] || CATEGORY_MAP['0600']).label; }
    function categoryColor(code)     { return (CATEGORY_MAP[code] || CATEGORY_MAP['0600']).color; }
    function categoryIcon(code)      { return (CATEGORY_MAP[code] || CATEGORY_MAP['0600']).icon; }

    function rankLabel(code)         { return (RANK_MAP[code] || RANK_MAP['5']).label; }
    function rankShort(code)         { return (RANK_MAP[code] || RANK_MAP['5']).short; }
    function rankSize(code)          { return (RANK_MAP[code] || RANK_MAP['5']).size; }
    function rankProminent(code)     { return (RANK_MAP[code] || RANK_MAP['5']).prominent; }

    // 标签最大显示距离(米),配合 Cesium `DistanceDisplayCondition` 使用。
    const RANK_LABEL_DISTANCE = {
        '1': Number.MAX_VALUE,    // 国保始终显示
        '2': 30000,
        '3': 15000,
        '4': 8000,
        '5': 4000,
    };
    function rankLabelMaxDistance(code) {
        return RANK_LABEL_DISTANCE[code] || 4000;
    }

    window.Dict = {
        CATEGORY_MAP, RANK_MAP, SEARCH_TYPE_MAP,
        categoryCode, rankCode,
        categoryLabel, categoryColor, categoryIcon,
        rankLabel, rankShort, rankSize, rankProminent,
        rankLabelMaxDistance,
    };
})();
