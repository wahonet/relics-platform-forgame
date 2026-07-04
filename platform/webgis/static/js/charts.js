// ECharts 仪表盘:各维度饼图 / 柱图 / 雷达等,点击图形追加统计筛选。
const _charts = {};
const _tt = { backgroundColor:'rgba(13,17,23,.95)', borderColor:'rgba(88,166,255,.3)', textStyle:{color:'#e6edf3',fontSize:11} };

function _ch(id) {
    if (!_charts[id]) _charts[id] = echarts.init(document.getElementById(id));
    return _charts[id];
}
window.addEventListener('resize', () => Object.values(_charts).forEach(c => c && c.resize()));

function countDim(relics, dim) {
    const counts = {};
    relics.forEach(r => { dimValues(r, dim).forEach(v => { counts[v]=(counts[v]||0)+1; }); });
    let keys = dim.order ? dim.order.filter(k=>counts[k]) : Object.keys(counts).sort((a,b)=>counts[b]-counts[a]);
    return { counts, keys };
}

function bindClick(chart, dimId) {
    chart.off('click');
    chart.on('click', p => { toggleStatFilter(dimId, p.name); });
}

function renderPie(id, dimId, relics) {
    const dim = DIMS.find(d=>d.id===dimId);
    const {counts,keys} = countDim(relics, dim);
    const cm = dimColorMaps[dimId] || buildColorMap(allRelics, dim);
    const c = _ch(id);
    c.setOption({
        tooltip:{trigger:'item',formatter:'{b}: {c} ({d}%)',..._tt},
        series:[{type:'pie',radius:['28%','58%'],center:['50%','52%'],
            data:keys.map(k=>({name:k,value:counts[k],itemStyle:{color:cm[k]||DEF_COLOR},
                label:{show:counts[k]/relics.length>0.05}})),
            label:{color:'#c9d1d9',fontSize:10,formatter:'{b}\n{c}'},
            labelLine:{lineStyle:{color:'rgba(255,255,255,.2)'}},
            emphasis:{itemStyle:{shadowBlur:10,shadowColor:'rgba(0,0,0,.5)'}},
        }],
    }, true);
    bindClick(c, dimId);
}

function renderHBar(id, dimId, relics) {
    const dim = DIMS.find(d=>d.id===dimId);
    const {counts,keys} = countDim(relics, dim);
    const cm = dimColorMaps[dimId] || buildColorMap(allRelics, dim);
    const c = _ch(id);
    const rev = [...keys].reverse();
    c.setOption({
        tooltip:{trigger:'axis',..._tt},
        grid:{left:6,right:36,top:6,bottom:6,containLabel:true},
        xAxis:{type:'value',splitLine:{lineStyle:{color:'rgba(255,255,255,.06)'}},axisLabel:{color:'#8b949e',fontSize:9}},
        yAxis:{type:'category',data:rev,axisLabel:{color:'#c9d1d9',fontSize:10,width:90,overflow:'truncate'},axisTick:{show:false},axisLine:{lineStyle:{color:'rgba(255,255,255,.08)'}}},
        series:[{type:'bar',data:rev.map(k=>({value:counts[k]||0,itemStyle:{color:cm[k]||DEF_COLOR}})),barWidth:10,
            itemStyle:{borderRadius:[0,3,3,0]},
            label:{show:true,position:'right',color:'#8b949e',fontSize:9,formatter:'{c}'},
        }],
    }, true);
    bindClick(c, dimId);
}

function renderVBar(id, dimId, relics) {
    const dim = DIMS.find(d=>d.id===dimId);
    const {counts,keys} = countDim(relics, dim);
    const cm = dimColorMaps[dimId] || buildColorMap(allRelics, dim);
    const c = _ch(id);
    c.setOption({
        tooltip:{trigger:'axis',..._tt},
        grid:{left:6,right:6,top:12,bottom:6,containLabel:true},
        xAxis:{type:'category',data:keys,axisLabel:{color:'#8b949e',fontSize:9,rotate:25,interval:0},axisTick:{show:false},axisLine:{lineStyle:{color:'rgba(255,255,255,.08)'}}},
        yAxis:{type:'value',splitLine:{lineStyle:{color:'rgba(255,255,255,.06)'}},axisLabel:{color:'#8b949e',fontSize:9}},
        series:[{type:'bar',data:keys.map(k=>({value:counts[k]||0,itemStyle:{color:cm[k]||DEF_COLOR}})),barWidth:14,
            itemStyle:{borderRadius:[3,3,0,0]},
        }],
    }, true);
    bindClick(c, dimId);
}

function renderRose(id, dimId, relics) {
    const dim = DIMS.find(d=>d.id===dimId);
    const {counts,keys} = countDim(relics, dim);
    const cm = dimColorMaps[dimId] || buildColorMap(allRelics, dim);
    const c = _ch(id);
    c.setOption({
        tooltip:{trigger:'item',formatter:'{b}: {c} ({d}%)',..._tt},
        series:[{type:'pie',roseType:'area',radius:['15%','60%'],center:['50%','52%'],
            data:keys.map(k=>({name:k,value:counts[k],itemStyle:{color:cm[k]||DEF_COLOR}})),
            label:{color:'#c9d1d9',fontSize:9,formatter:'{b}\n{c}'},
            labelLine:{lineStyle:{color:'rgba(255,255,255,.2)'}},
            emphasis:{itemStyle:{shadowBlur:10,shadowColor:'rgba(0,0,0,.5)'}},
        }],
    }, true);
    bindClick(c, dimId);
}

function renderRadar(id, dimId, relics) {
    const dim = DIMS.find(d=>d.id===dimId);
    const {counts,keys} = countDim(relics, dim);
    const cm = dimColorMaps[dimId] || buildColorMap(allRelics, dim);
    const maxVal = Math.max(...keys.map(k=>counts[k]||0), 1);
    const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#58a6ff';
    const c = _ch(id);
    c.setOption({
        tooltip:{..._tt},
        radar:{indicator:keys.map(k=>({name:k,max:maxVal})),
            axisName:{color:'#8b949e',fontSize:9},
            splitArea:{areaStyle:{color:['rgba(88,166,255,.02)','rgba(88,166,255,.04)']}},
            splitLine:{lineStyle:{color:'rgba(255,255,255,.06)'}},
            axisLine:{lineStyle:{color:'rgba(255,255,255,.08)'}},
        },
        series:[{type:'radar',
            data:[{value:keys.map(k=>counts[k]||0),name:'数量',
                areaStyle:{color:'rgba(88,166,255,.15)'},
                lineStyle:{color:accentColor,width:2},
                itemStyle:{color:accentColor},
            }],
        }],
    }, true);
}

function renderTreemap(id, dimId, relics) {
    const dim = DIMS.find(d=>d.id===dimId);
    const {counts,keys} = countDim(relics, dim);
    const cm = dimColorMaps[dimId] || buildColorMap(allRelics, dim);
    const c = _ch(id);
    c.setOption({
        tooltip:{formatter:'{b}: {c}',..._tt},
        series:[{type:'treemap',roam:false,nodeClick:false,breadcrumb:{show:false},
            label:{show:true,color:'#e6edf3',fontSize:10,formatter:'{b}\n{c}'},
            data:keys.map(k=>({name:k,value:counts[k],itemStyle:{color:cm[k]||DEF_COLOR,borderColor:'rgba(13,17,23,.6)',borderWidth:2}})),
        }],
    }, true);
    bindClick(c, dimId);
}

const _defaultChartTypes = {
    chCat:       { dimId: 'category_main',  type: 'pie' },
    chLevel:     { dimId: 'heritage_level', type: 'bar' },
    chSurvey:    { dimId: 'survey_type',    type: 'pie' },
    chTown:      { dimId: 'township',       type: 'bar' },
    chEra:       { dimId: 'era',            type: 'vbar' },
    chOwner:     { dimId: 'ownership_type', type: 'pie' },
    chIndustry:  { dimId: 'industry',       type: 'bar' },
    chRisk:      { dimId: 'risk_factors',   type: 'bar' },
    chCondition: { dimId: 'condition_level', type: 'pie' },
};

function _getChartConf(chartId) {
    return (typeof _chartTypes !== 'undefined' && _chartTypes[chartId]) || _defaultChartTypes[chartId];
}

function _renderByConf(chartId, relics) {
    const conf = _getChartConf(chartId);
    if (!conf) return;
    const renderers = { pie: renderPie, bar: renderHBar, vbar: renderVBar, rose: renderRose, radar: renderRadar, treemap: renderTreemap };
    (renderers[conf.type] || renderPie)(chartId, conf.dimId, relics);
}

function renderAllCharts(relics) {
    document.getElementById('stTotal').textContent = relics.length;
    document.getElementById('st3d').textContent = relics.filter(r=>is3D(r)).length;

    DIMS.forEach(d => { if(!dimColorMaps[d.id]) dimColorMaps[d.id]=buildColorMap(allRelics,d); });

    Object.keys(_defaultChartTypes).forEach(id => _renderByConf(id, relics));

    document.querySelectorAll('.dash-sec h4').forEach(h => {
        h.classList.toggle('active', h.getAttribute('onclick').includes(activeGroup));
    });
}

function setColorBy(dimId) {
    activeGroup = dimId;
    dimColorMaps[dimId] = buildColorMap(allRelics, DIMS.find(d=>d.id===dimId));
    _symbolCache = {};
    renderPoints(filtered);
    renderAllCharts(filtered);
    updateLegend();
}

function toggleStatFilter(dimId, value) {
    if (statFilters[dimId] === value) {
        delete statFilters[dimId];
    } else {
        statFilters[dimId] = value;
        if (activeGroup !== dimId) activeGroup = dimId;
        dimColorMaps[dimId] = buildColorMap(allRelics, DIMS.find(d=>d.id===dimId));
    }
    onFilterChange();
}

function updateLegend() {
    const dim = DIMS.find(d => d.id === activeGroup);
    const cm = dimColorMaps[activeGroup] || {};
    document.getElementById('legendTitle').textContent = dim ? dim.label : '分类图例';
    const body = document.getElementById('legendBody');

    if (_symbolMode) {
        if (activeGroup === 'category_main') {
            body.innerHTML = Object.entries(cm).map(([cat, color]) => {
                if (CATEGORY_ICONS[cat]) {
                    const iconUrl = makeLegendIcon(cat, color);
                    return '<div class="lg-item"><img src="'+iconUrl+'" style="width:14px;height:14px;border-radius:50%;flex-shrink:0">'+cat+'</div>';
                }
                return '<div class="lg-item"><div class="lg-dot" style="background:'+color+'"></div>'+cat+'</div>';
            }).join('');
        } else {
            const catDim = DIMS.find(d => d.id === 'category_main');
            const catCounts = {};
            filtered.forEach(r => { var cv = catDim ? dimValue(r, catDim) : r.category_main; if (cv) catCounts[cv] = (catCounts[cv]||0)+1; });
            const uniqueCats = Object.keys(catCounts).sort((a,b) => catCounts[b]-catCounts[a]);
            const primaryCat = uniqueCats.length === 1 ? uniqueCats[0] : null;

            if (primaryCat && CATEGORY_ICONS[primaryCat]) {
                document.getElementById('legendTitle').textContent = dim.label + ' · ' + primaryCat;
                body.innerHTML = Object.entries(cm).map(([k, c]) => {
                    const iconUrl = makeLegendIcon(primaryCat, c);
                    return '<div class="lg-item"><img src="'+iconUrl+'" style="width:14px;height:14px;border-radius:50%;flex-shrink:0">'+k+'</div>';
                }).join('');
            } else {
                const items = [];
                Object.entries(cm).forEach(([dimVal, color]) => {
                    if (uniqueCats.length <= 3) {
                        uniqueCats.forEach(cat => {
                            if (!CATEGORY_ICONS[cat]) return;
                            const iconUrl = makeLegendIcon(cat, color);
                            items.push('<div class="lg-item"><img src="'+iconUrl+'" style="width:14px;height:14px;border-radius:50%;flex-shrink:0">'+dimVal+'·'+cat+'</div>');
                        });
                    } else {
                        items.push('<div class="lg-item"><div class="lg-dot" style="background:'+color+'"></div>'+dimVal+'</div>');
                    }
                });
                body.innerHTML = items.join('');
            }
        }
    } else {
        body.innerHTML = Object.entries(cm).map(([k,c]) =>
            '<div class="lg-item"><div class="lg-dot" style="background:'+c+'"></div>'+k+'</div>'
        ).join('');
    }
}
