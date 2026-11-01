// Shared sample data for all three directions: query “设计”, results grouped by day.
window.HISTORY = {
  query: '设计',
  total: 23,
  groups: [
    {
      label: '今天',
      items: [
        {
          title: '历史搜索弹窗 v3 设计稿 – Figma', host: 'figma.com', icon: 'figma.com',
          time: '10:42', full: '今天 10:42', visits: 18, links: 3, selected: true,
          url: 'https://www.figma.com/design/Kq2nB7/history-popup-v3',
          variants: [
            { label: '弹窗 · 列表态', path: '?node-id=12-4', visits: 11 },
            { label: '弹窗 · 空状态', path: '?node-id=88-2', visits: 5 },
            { label: '原型演示', path: '/proto/Kq2nB7', visits: 2 }
          ]
        },
        {
          title: '设计规范（团队版）', alias: '移动端交互规范 v2.3 – 飞书文档', renamed: true, pinned: true,
          host: 'bytedance.feishu.cn', letter: '飞', tint: '#3370ff', time: '09:15', visits: 42
        },
        { title: '如何设计一个好用的命令面板 – 少数派', host: 'sspai.com', icon: 'sspai.com', time: '08:30', visits: 3 }
      ]
    },
    {
      label: '昨天',
      items: [
        {
          title: '苹果设计指南', alias: 'Human Interface Guidelines – Apple Developer', renamed: true,
          host: 'developer.apple.com', icon: 'developer.apple.com', time: '21:04', visits: 9
        },
        { title: '设计周会纪要 – Notion', host: 'notion.so', icon: 'notion.so', time: '16:20', visits: 27, links: 4 },
        { title: 'Material Design 3 设计组件 · 搜索栏', host: 'm3.material.io', icon: 'm3.material.io', time: '11:05', visits: 4 }
      ]
    },
    {
      label: '本周',
      items: [
        { title: 'Search UI 设计灵感 – Dribbble', host: 'dribbble.com', icon: 'dribbble.com', time: '周三', visits: 6 },
        { title: 'raycast/extensions · 设计讨论 #1284 – GitHub', host: 'github.com', icon: 'github.com', time: '周二', visits: 2 },
        { title: '设计评审 Backlog – Linear', host: 'linear.app', icon: 'linear.app', time: '周一', visits: 12 }
      ]
    }
  ]
};

window.markQuery = (text, query = window.HISTORY.query) =>
  text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    .split(query).join(`<mark>${query}</mark>`);

window.iconHtml = (item, className) => item.icon
  ? `<img class="${className}" src="${window.ICONS[item.icon]}" alt="">`
  : `<span class="${className} letter" style="background:${item.tint}">${item.letter}</span>`;
