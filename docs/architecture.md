# 三部分划分：操作系统 / 虚拟硬件 / 透明化面板

整个项目只有三个部分，一个部分一个文件夹，谁也不给谁留赘余。

| 部分 | 目录 | 是什么 | 里面有什么 |
| --- | --- | --- | --- |
| 虚拟硬件 | `src/hw/` | 这台机器本身 | CPU 与指令集、主存、盘位（块设备 + IndexedDB + 镜像）、控制台（屏幕 / 键盘 / 串口寄存器）、硬件时钟与中断、总线 / MMU / 块控制器 |
| 操作系统 | `src/os/` | 跑在这台机器上的 crados | 引导与加载器、进程表与调度、系统调用、VFS / ext2、账户、`/bin` 程序源码、联机手册、CRX 内核（`guestkernel.ts` + `guestpolicy.ts`） |
| 透明化面板 | `src/cp/` | 观测层 | 快照层 `snapshot.ts` + 进程 / 内存 / 存储 / 调用 / 日志五个面板 |

机器本身还带一个前端：`src/hw/ui/` 是显示器、键盘、机箱控制条与上电菜单（启动菜单就是固件的"从哪个介质启动"），
它跟硬件一样属于"机器"。根目录的 `src/Plain.tsx` 与 `src/Transparent.tsx` 是装配层：
前者把机器与操作系统装成纯净版，后者再叠上面板。

## 依赖方向

```
src/Plain.tsx ─────────────┐
                           ├─→ hw/ui（屏幕、键盘、固件）──→ os 的启动入口
src/Transparent.tsx ──┬────┘                              │
                      │                                   ▼
                      └─→ cp（面板）──────────────→ hw（机器）←── os（操作系统）
```

- **hw 核心不认识 os，也不认识 cp**：机器自己就能转（`Machine` 有主存、盘位、控制台、时钟、总线）。
- **os 依赖 hw**：操作系统是被装载到机器上的软件，它调用机器的接口，机器只通过 `MachineSoftware` 反向找它。
- **cp 依赖 hw + os，但只读**：面板从机器（主存字节、盘位、控制台）与操作系统（进程表、挂载表、通知口）取数据。
- **cp 只被透明版入口引用**：纯净版把整个 `src/cp` 排除在打包之外。
- **hw/ui 引用 os 的启动入口与只读接口**：这是"人给机器上电、机器装载操作系统"的方向。

这些方向由 `npm run parts`（`scripts/parts-check.mjs`）读 import 图逐条断言，
CI 的 `npm run check` 会跑它；纯净版构建另有一道产物检查（下面"不变量"）。

## 边界是怎么切的

几条实际的线，说明为什么某段代码在某一侧：

- **磁盘**：字节数组、几何（1 MiB / 1024 块）、块读写、IndexedDB 分块存档、`.img` 导入导出、热插拔、
  脏分块回写队列 —— 全是虚拟硬件（`hw/disk.ts`、`hw/store.ts`、`hw/bay.ts`）。
  盘上是什么格式与硬件无关：ext2 的超级块、inode、位图、目录项、权限位是操作系统的事（`os/ext2.ts`、`os/fs.ts`）。
- **一次读写要过谁**：块控制器命令 1/2（用户态原始块读写）在硬件里只有"DMA + 一个授权问句"，
  授权由操作系统回答（`rawBlockIOAllowed()`，当前进程 euid 是不是 root）；命令 4/5 是内核自己的暂存区搬运。
- **内存**：`hw/ram.ts` 是主存条与帧位图；页表怎么填、进程怎么分页是操作系统与 CRX 内核的事。
  MMU 的翻译缓存只看"这次写是不是落在页表字节上"（`AddressSpace.isPageTableByte`），布局由操作系统提供。
- **控制台**：屏幕行、UTF-8 流解码、`ESC[2J`、回显开关、规范模式行缓冲、串口寄存器（`0xFF00`..`0xFF12`）在硬件里；
  Ctrl-C 该杀谁、谁能收到信号、密码输入要不要关回显，是操作系统的行规。
- **时钟**：硬件按真实时间产生定时器中断（`hz`、Turbo 的节拍与"不限速"批处理由机器与操作系统分工：
  机器给节拍，操作系统决定一批跑多少），中断向量号是硬连线（syscall 0、timer 1、tty 3）。
- **系统调用号段**：`svc` 陷出时只带 `num` 与 `r0..r3`，CPU 不解释号的含义；
  `os/kernel.ts` 的 `hypercall()` 把它们翻译成 exit / kill / hwexec / hwreap / hwmount / hwacct / hwassemble / hwdisasm。
- **面板**：只通过只读接口取数（`kernel.machine.*`、`kernel.processes()`、`kernel.filesystem()`、`kernel.observer`）。
  操作系统不装观察者时一条追踪数据都不产生；`/cp` 整个删掉，操作系统与硬件不会少任何东西。
  只有"介质动作"是例外：导出镜像、立刻回写这类纯粹是硬件工作的按钮，面板直接问盘位（`kernel.machine.disks`）。

## 这次搬走的东西（曾经混在一起的）

- `os/blockdev.ts` → `hw/disk.ts`（设备）+ `hw/store.ts`（IndexedDB 存档）+ `hw/bay.ts`（盘位、热插拔、回写队列）。
- `os/memory.ts` → `hw/ram.ts`；`os/vm.ts` → `hw/cpu.ts`（CPU 只产生 yield / halt / svc 三种陷出）；`os/isa.ts` → `hw/isa.ts`。
- 内核里的总线、MMU、块控制器寄存器、串口、终端屏幕缓冲、硬件时钟、落盘事务 → `hw/bus.ts`、`hw/console.ts`、`hw/machine.ts`、`hw/bay.ts`。
- `src/ui/` → `hw/ui/`：终端是机器的显示器与键盘，启动菜单是固件的启动介质选择，机箱条上的频率旋钮改的是硬件时钟。
- `src/man/` → `os/man/`：手册是系统盘上的文件（`rootimg.ts` 把它们写进出厂镜像）。
- `src/utils/` 拆掉：`OS_VERSION` 归操作系统（`os/version.ts`），样式合并工具 `cn` 归机器的前端（`hw/ui/cn.ts`），
  面板自带一份（`cp/cn.ts`）—— 三部分谁都不借谁的小工具。

## 不变量

- `npm run parts`：三部分边界检查（上面那些依赖方向）。
- `npm run check`：`typecheck` + `parts` + `smoke` + `persist` + `ext2`，CI 每次推送都跑。
- 纯净版产物里不能出现面板：CI 在打包后 grep `crados/control-panel`（`cp/snapshot.ts` 里的 `PANEL_TAG`，
  类名会被压缩混淆，字符串不会），出现在 `dist/index.html` 里就构建失败。
