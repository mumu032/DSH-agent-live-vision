/**
 * agent-live —— DSH 插件（浏览器半端）
 * ============================================================================
 * 在 DSH 里加两处入口：
 *   · 侧边栏一个图标（sidebar.panellist + main）：点开就是整页探测台
 *   · 设置里一页「实时探测」：同一个页面，放在设置里方便找
 *
 * 页面本身没被重写 —— 服务端已经把原来的 index.html 原样挂在
 * `/api/agent-live/` 下，这里只是用 iframe 把它嵌进来。同源，所以里面的
 * EventSource 和相对路径的 /api 全都能直接用，不用改一行前端代码。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'agent-live',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const SRC = '/api/agent-live/'

    const CSS = `
      [data-al] { display: flex; flex-direction: column; height: 100%; min-height: 420px; gap: 8px; }
      [data-al] iframe { flex: 1 1 auto; width: 100%; min-height: 420px; border: 0; border-radius: 10px; background: #070b14; }
      [data-al] .al-hint { font-size: 12px; opacity: .62; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      [data-al] a { color: #6f9bff; text-decoration: none; }
      [data-al] a:hover { text-decoration: underline; }
      [data-al] .al-icon { display: inline-flex; align-items: center; justify-content: center; width: 100%; height: 100%; }
    `

    /** 整页：iframe 铺满，右上角给一个「新窗口打开」。 */
    function Page() {
      return h('div', { 'data-al': '' },
        h('iframe', { src: SRC, title: '实时探测', allow: 'clipboard-write' }),
        h('div', { className: 'al-hint' },
          h('span', null, '页面来自 /api/agent-live/，只读这些账本，不写任何东西。'),
          h('a', { href: SRC, target: '_blank', rel: 'noreferrer' }, '在新窗口打开↗')))
    }

    /** 设置页里那一条：给它一个说明 + 同一个页面。 */
    function SettingsPage() {
      return h('div', { 'data-al': '' },
        h('div', { className: 'al-hint' },
          h('span', null, '看她此刻在做什么：实时流、去过哪些平台、今天出门几次、最近醒来。只读。')),
        h('iframe', { src: SRC, title: '实时探测', allow: 'clipboard-write' }))
    }

    function Icon() {
      // 一个小雷达：同心圆 + 一根扫描线
      return h('span', { className: 'al-icon', 'aria-hidden': 'true' },
        h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none' },
          h('circle', { cx: 12, cy: 12, r: 8.5, stroke: 'currentColor', strokeOpacity: 0.5, strokeWidth: 1.4 }),
          h('circle', { cx: 12, cy: 12, r: 4.2, stroke: 'currentColor', strokeOpacity: 0.75, strokeWidth: 1.4 }),
          h('path', { d: 'M12 12 L18.2 6.6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
          h('circle', { cx: 12, cy: 12, r: 1.6, fill: 'currentColor' })))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'agent-live')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'agent-live: 样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        // 每一处注册都单独兜住：某一种插槽在当前 DSH 版本不认，另外两个还活着。
        const seat = (label, fn) => { try { fn() } catch (e) { console.warn('[agent-live] ' + label + ' 没挂上：', e?.message ?? e) } }

        // 设置里的一页（最稳的一条，memory-board 用的就是它）
        seat('settings.section', () => slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'agent-live', order: 33, label: '实时探测' },
          () => h(SettingsPage),
        )))

        // 侧边栏图标 + 中央面板（key 要跟侧边栏条目 id 一致，DSH 才会派发过去）
        seat('sidebar.panellist', () => slots.inject('sidebar.panellist', () => slots.register(
          { name: 'sidebar.panellist', id: 'agent-live', order: 40, label: '实时探测' },
          () => h(Icon),
        )))
        seat('main', () => slots.inject('main', () => slots.register(
          { name: 'main', key: 'agent-live' },
          () => h(Page),
        )))
      },
    }
  },
})
