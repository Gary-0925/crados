// 控制字符在终端显示为占位符，避免系统字体把它画成随机字形
export const showCtl = (s: string): string => s.replace(/[\0-\x1f\x7f]/g, '\ufffd')
