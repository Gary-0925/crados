// 面板自带的样式合并（clsx + tailwind-merge）。
// 三部分各自独立，这点小工具也不跨部分借用。
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
