# crados 性能与工程化优化笔记

这份笔记记录一次针对 crados 3.4 的优化：先测量，再动手，最后留下可以复现的命令。
所有数字都在本机 Node 22.22.3 上测得（同一台机器、同一次会话内对比）；浏览器里的绝对值会不同，
但量级与比例是一致的。

---

## 一、测量的起点

| 项目 | 测量值 | 说明 |
| --- | --- | --- |
| 引导（`new Kernel()`） | 69 ms | 其中汇编 42 个 /bin 程序 31 ms、CRX 内核 29 ms |
| 解释器吞吐（空闲） | **1.15 MIPS** | 每指令约 870 ns，约 14 ms 宿主 CPU / tick |
| 空闲 tick 的指令数 | **16 384** | 8 个 slice × 2048 条，全部烧在 idle 的 `sys/iret` 循环里 |
| ControlPanel 每帧刷新 | **9.8 ms** | 每次变化都重建整棵目录树并反汇编全部 42 个可执行文件 |
| 单文件产物 | 521 kB / gzip 154 kB | 内嵌 217 KiB 汇编与手册文本 |

CPU 剖析（`node --cpu-prof`，400 个 tick）：

```
50.9%  runExe           解释器主循环
14.9%  fetch            每条指令 4 次 bus.read 闭包调用
10.1%  tick             宿主调度泵
 6.4%  get / set        寄存器属性访问器（PCB 字节）
 2.5%  kernelAddr       MMU 内核态路径
 1.3%  get limit        每次取指都要走一遍地址上界访问器
```

结论：真正花时间的不是"指令语义"，而是**访存的调用链**（闭包 + 属性访问器 + 每次访存新建的对象）。

---

## 二、已经落地的改动

### 1. MMU 与总线热路径（`os/vm.ts`、`os/process.ts`、`os/kernel.ts`）

- **每进程页表缓存**：`vpn → (pfn | supervisor<<15)` 存在一个 `Int32Array(16)` 里，
  访存不再调用 `pteAt()`（原来每次访存都要新建一个 `{pfn, supervisor}` 对象）。
- **失效用一个纪元计数器**：任何把 PCB 页表字节写掉的操作都会 `xlateEpoch++`
  （宿主写、客户机 `ustb` 写都覆盖），下一次访存自动重建缓存。
- **取指不再分配数组**：原来 `const [op, rr, hi, lo] = fetch(...)` 每条指令分配一个 4 元数组。
- **16 位回绕改用位运算**：`(v % 0x10000 + 0x10000) % 0x10000` → `v & 0xffff`。
- **寄存器访问器直接捕获字节数组**：省掉 `this.mem.bytes` 一层跳转，语义不变。

效果：解释器 **1.15 → 1.67 MIPS（+45%）**；对同一段会话脚本，控制台输出逐字节一致。

### 2. 空闲不再烧 CPU（`os/guestkernel.ts`）

idle 进程原来是 `mov r0,0; sys; jmp idle`：`sys` 进内核、`do_schedule` 扫一圈 PCB、
发现没有别的就绪进程、`iret` 回到用户态，然后再来一遍——每个时间片都会被填满 2048 条指令。

改成"没有别的进程可跑时把 CPU 交还宿主"：

```asm
yield_same:
    sched               ; 没有别的进程可跑：交还宿主，而不是把时间片烧在 sys/iret 循环里
    mov r0, 0
    iret
```

效果：空闲时 **16 384 → 1 773 指令/tick**，宿主 CPU **约 14 ms → 0.9 ms / tick（约 15 倍）**。
登录提示符挂着不动时，浏览器不再占满一个核。
调度语义（后台任务、`sleep`、僵尸、`count 6 a &` 的交叉输出）逐项复测通过。

### 3. 观测层只在需要时干活（`cp/snapshot.ts`）

transparent 版的控制面板此前在**每次变化**（内核每个 tick 都会 `emit`）时重建快照：
递归遍历整棵目录树、读每个文件的字节、把 42 个可执行文件全部反汇编一遍。

改成：

- **目录树惰性构建**：`snap.tree` 变成 getter，只有真正渲染"存储"面板时才计算；
- **内容哈希缓存**：文件内容（FNV-1a）没变就不重新解码/反汇编；
- **限流 + 失效**：同一棵树在 400 ms 内复用，`invalidate()`（用户改动了文件系统）立刻重建；
- **分块 latin1 转换**：`String.fromCharCode(...raw)` 对稍大的文件会爆栈，改为每 8 KiB 一块。

效果：**每帧 9.8 ms → 0.20 ms**；首次打开存储面板 20 ms（一次性）；文件系统真变了才 2.7 ms 重建。

### 4. 工程化：让回归能被抓住

- `npm run typecheck`（`tsc --noEmit`）：以前 CI 从不做类型检查，仓库里躺着一个真错误
  （`killSig(undefined)` 的分支）；顺手修掉（不存在的 pid 现在按 ESRCH 处理，而不是崩内核）。
- `npm run smoke`：无头冒烟测试（`scripts/smoke.ts` + `scripts/smoke.mjs`，用 esbuild 打包后跑），
  覆盖引导、42 个程序的装配、登录、`ls/as/count/重定向/ps/lsblk/dmesg` 输出，
  以及观测层的快照与目录树。
- `npm run check`：上面两步串起来。
- CI（`.github/workflows/deploy.yml`）：新增 `verify` job，两个构建都 `needs: verify`；
  每个 job 打开 `cache: npm`。

---

## 三、还没做，但值得做的（按收益/风险排序）

### A. 寄存器缓存 + 边界同步（最大的一块，已量化）

现在 `pc/sp/flags/8 个通用寄存器/mode` 都是 **PCB 字节上的属性访问器**，
每条指令要读写十几次。实验（把 CPU 状态整个搬进 JS 字段，其余不变）在同一负载上：

```
PCB 访问器（现状）      1.67 MIPS
JS 侧 CPU 状态          7.04 MIPS   ← 4.2 倍
```

这不动"状态真相在 PCB 字节里"的设定也能做：**片内**用 JS 侧寄存器跑，**每个边界**再写回 PCB：

- 发生 trap（`sys`）、`sched`、生成器让出（每个 slice 结束）时，把 JS 状态刷回 PCB 字节；
- 宿主在边界处读寄存器（调度、`dispatch` 写返回值、面板、`ps` 这类读 PCB 的程序）时，先读 PCB；
- 客户机内核自己写 PCB 的地方（`do_schedule` 改 state/pid）不受影响；
- 客机内核**不**碰寄存器bank（已确认），所以不需要双向同步，只需要边界回写；
- 配一个 `DEBUG_SYNC` 开关：每片结束后比对 JS 状态与 PCB 字节，不一致就 panic，
  用冒烟测试跑一遍即可确信没有漏点。

### B. 把机器搬进 Web Worker

现在解释器跑在主线程上，20 Hz 的 tick 又是实打实的 CPU 时间（忙时约 10 ms/tick），
MAX 模式下会直接和渲染抢线程。把 `Kernel` 放进 Worker、用 `postMessage` 传
"控制台行/快照"（都是可结构化克隆的普通对象），主线程只做渲染：
UI 不再丢帧，MAX 也能跑满，代价是内核接口要变成异步。

### C. 持久化只回写脏块

`AUTOSYNC_MS = 1000`：只要 `dirty`，`flush()` 就会把**整块 1 MiB 的 sda** base64 编码后写进
`localStorage`（约 1.4 MB 的字符串，一秒一次，同步 API）。现在持久化已经改成按 16 KiB 分块、只写变化的分块；
再往前一步就是：

- `BlockDev` 记一个脏块集合（宿主写路径能看到块号）；
- `localStorage` 按块存（`crados.blk.sda.<n>`）或用 IndexedDB 存整块二进制（省掉 base64 的 33% 膨胀，且不阻塞主线程）；
- 导入的镜像同理。

### D. 终端渲染

`Terminal` 每帧把 600 行 × 若干 span 全部交给 React 协调；
`showCtl()` 也是每帧对每行重新做正则替换。可以做：

- 行级 `memo`（内核追加行时只改最后一行，前面的行对象引用稳定，天然适合 memo）；
- 虚拟滚动（只渲染视口内的行）；
- 输入法/移动端：加一个隐藏的 `<input>` 承接移动端软键盘。

### E. 其它小项

- `express`、`playwright` 在 `src/`、CI、`index.html`、`vite.config.ts` 里都没有引用；
  它们躺在 `dependencies` 里，`npm ci` 会连带下载 Playwright 的浏览器包。
- `package.json` 的 `name` 还是 `react-vite-tailwind`，`version` 与 `OS_VERSION` 两处维护。
- 两个入口靠 CI 改写 `src/App.tsx` 实现，本地要手动改；可以换成虚拟模块或
  `vite build --mode`，或者干脆用两个 HTML 入口。
- `index.html` 没有 description / favicon / og 标签——对一个要被分享的演示项目，
  这几个字节的收益比很多性能优化都大。
- `dmesg` 输出里能看到 KMSG 环形缓冲区的残留字节（`\u0000` 与旧数据），
  说明"丢整行"的截断逻辑会让 `len` 与内容对不上。

---

## 四、复现

```bash
npm ci
npm run check        # 类型检查 + 无头冒烟测试
npm run dev          # 本地看 plain 版（transparent 版改 src/App.tsx 的导出）
npm run build        # 单文件产物
```

临时基准（放在仓库外，不参与构建）：

```bash
# 解释器吞吐：把内核跑 60 tick 预热后测 400 tick
node --cpu-prof --cpu-prof-dir=/tmp/prof /tmp/bench/prof.mjs
```

测量脚本用 esbuild 打包 `src/`（需要一个把 `?raw` 变成 text 模块的插件、并把 `@` 指到 `src/`），
`scripts/smoke.mjs` 里就是这份配置，可以直接抄。

## 五、文件系统：CRFS → ext2

原来的 `CRFS` 是自造格式（256 B 块、48 B inode、大端、NUL 填充的目录项）。
现在换成 **真的 ext2**，理由和取舍记录如下。

### 为什么是 ext2，不是 ext4 / NTFS

- **ext2**：超级块、块位图、inode 位图、inode 表、12 个直接块 + 一级间接块、线性目录
  （`rec_len` 链）——每一层都能讲清楚，也都能用机器码实现。没有日志意味着 `sync()`
  的语义就是"把脏块写回去"，不需要解释日志重放。
- **ext4**：多出来的是 extent 树、日志、元数据校验和、htree 目录索引、flex_bg、64 位块号。
  对一个教学内核，这些只增加实现量和"看不见的状态"，不增加可解释性。
- **NTFS**：MFT 的 fixup/update-sequence 数组、常驻/非常驻属性、data runs、目录 B+ 树
  （$I30）、$LogFile/$Secure/$Extend 一整族元数据文件。格式文档来自逆向，Linux 下工具也弱，
  复杂度约为 ext2 的 4~6 倍。

### 落地的配置（`src/os/ext2.ts`）

    块大小 1024（s_log_block_size = 0）     inode 128 字节       s_magic = 0xEF53
    s_feature_compat     不使用
    s_feature_incompat   filetype（目录项带类型字节）
    s_feature_ro_compat  sparse_super | large_file（读得进带 resize_inode 的盘，但自己从不写）
    inode 1..10 为保留区（同 mke2fs），s_first_ino = 11，根目录 inode 2，lost+found inode 11

### 怎么验收的

`npm run ext2`（`scripts/ext2-check.mjs`）交给真的 e2fs 工具，双向验证：

1. **我们造盘** → `e2fsck -fn` 干净通过；`dumpe2fs` 报的块大小 1024、magic 0xEF53、
   特性集里没有 extent/metadata_csum/dir_nlink/64bit；`debugfs` 能 `ls`、`stat`（16 KiB 文件、
   12 个数据块 + 一级间接块）、`cat`（12 本手册与二进制内容）。
2. **反向**：真 `mke2fs -t ext2` 造的盘，我们的解析器能读出卷标、`lost+found`（inode 11），
   能在上面新建文件、写内容，且 `e2fsck` 依然通过、`debugfs` 读得到我们写的数据。

这一路修掉的三个真实 bug（都是 e2fsck 抓出来的，不是自己"觉得对"）：

- `writeInode()` 会用陈旧的 `i_block` 覆盖刚分配的块指针 → 根目录数据块变成"孤儿"，
  下一次扫描读到 `rec_len = 0` 死循环。现在块指针只在显式要求时才写回。
- `create()` 写 `i_mode` 时漏了类型位 → e2fsck 判为非法 inode，连带它的数据块全被当成泄漏。
- 位图末尾的填充位没置 1、inode 1..10 保留区没标占用 → `padding is not set` /
  `Inode bitmap differences`。

### 已经接上的（宿主侧，全部通过 e2fsck/debugfs 验收）

| 文件 | 改动 |
| --- | --- |
| `src/os/ext2.ts` | 新增格式层：出盘、读写、位图、目录项、间接块、设备节点、块用途图、`pathOf` |
| `src/os/blockdev.ts` | sda 变成 **1024 × 1 KiB = 1 MiB**；持久化从"整盘 base64 每秒重写"改成**按 16 KiB 分块、只写变化的分块** |
| `src/os/fs.ts` | 宿主 VFS 建在 ext2 上：类型取自 `i_mode`、权限就是 POSIX 位（`M_*` 现在是真实掩码）、属主取自 `i_uid`、父目录取自目录项 `'..'`、设备号放在 `i_block[0]`、`blockMap()` 直接报块组/位图/inode 表/目录/文件的用途 |
| `src/os/rootimg.ts` | 出厂根盘由 `formatExt2()` 生成（含 `/etc/passwd`、手册、设备节点、示例源码） |
| `src/os/kernel.ts` | 去掉 CRFS 时代的凭证迁移（`ensureCreds`/`seedModes`/`markCreds`），`/bin` 重烧改成 unlink 回收 |
| `scripts/ext2-check.mjs` | 双向验收：自造盘 + 真 `mke2fs -t ext2` 的盘；并演练**出厂根盘镜像**：`/etc/passwd` 内容与 0644、`/dev/tty` 是字符设备、`/tmp` 是 1777、`/` 是 0755、目录 `..` 可回溯、`/usr/man` 可被 debugfs 列出、烧写 `/bin` 之后 e2fsck 依然干净 |

### CRX 机器码里的文件系统（已完成）

宿主换盘只是前半段：CRX 汇编层原来按 CRFS 解析 sda，所以那一步之后系统只能引导到
"init 启动"就停住。后半段是把 guest 侧整体改成 ext2 语义，做法如下：

1. **接口不变、实现换掉**。`vfs_u8 / vfs_u16 / vfs_inode / vfs_dirent / vfs_lookup /
   vfs_resolve / vfs_setdev / vfs_may / ino_in_range` 这些名字全部保留，内部换成
   ext2：inode 偏移 = `5 * 1024 + (ino - 1) * 128`；u16 一律小端；目录项按 `rec_len`
   串到 `i_size` 为止，名字前多了 8 字节头。
2. **新增一层"数据偏移 → 盘上偏移"**：`vfs_dskoff` 走 `vfs_ptr`（12 个直接块 +
   一级间接块），目录遍历、目录项增删全部改成数据偏移，不再假设目录块连续。
3. **读写路径重写**：`write_file_*` 负责块分配、`i_size`（u32 低 16 位）、`i_blocks`
   （512 B 扇区计数）与 `d_time`；`read_*` 同理解析直接块与间接块。
4. **KCB 暂存字重新分区**：ext2 层独占 `0x009C–0x00AC`（分配器状态字）、`0x00AE`、
   `0x00B8`、`0x00BC`、`0x00BE`；策略层用 `0x00B0–0x00B6` 与 `0x00BA`；`0x00BF` 只当
   调试标记。分区写进了两边的文件头注释，改任何一处都要先看那张表。
5. `man storage`、`man inspect` 与 README 的盘上格式叙述一起改成 ext2。

这一段里 e2fsck 抓出来的真实 bug（都不是"自己觉得对"）：

- **`vfs_dirent` 把回参写在 r7，却同时让调用方用 r7 当循环计数器** → `gp_getcwd`
  永远走不到根、shell 提示符退化成 `/root//n/ATH/oot///…`。深度改存 KCB `0x0096`。
- **`sys_open` 里调用 `vfs_type` 前把 inode 重新读进 r1** → 上一跳的返回值被覆盖，
  登录后的第一条命令一律 `cannot open`。
- **`sys_getdents` 少传 `vfs_dirent` 的偏移参数（r2）** → 每轮都读第 0 条记录，
  `ls` 无限循环。
- **新的目录项直接按 `need` 收尾**，把原本一条 `rec_len = 1024` 的记录断成
  `rec_len = need`，后面的空间成了"读不到的洞" → 第二个文件建不进去。
- **`sys_write` 用 `vfs_setdev` 切盘时没保护 r4/r5**（它破坏 r0/r4/r5）→ 用户缓冲区
  指针和长度变成垃圾，写文件时探到 `0x200` 就越界，`cat /tmp/a` 报错。
- **`vfs_free_ino` / `vfs_free_blocks` / `vfs_dir_init` 把 inode 存在 `0x00A2`**，
  而它们往下调的 `vfs_free_block` / `vfs_alloc_block` 是分配器家族，会把 `0x009C–0x00A4`
  整片重写 → 释放文件时清的是随便一个 inode 的位图位（e2fsck 报
  `Inode bitmap differences: -83`）。
- **`i_blocks` 从不维护、删除的 inode 没有 `i_dtime`、`bg_used_dirs_count` 不跟着加减** →
  e2fsck 报 `i_blocks is 0, should be 2`、`Deleted inode 83 has zero dtime`、
  `Directories count wrong`。现在建文件、建目录、删文件都同步这三个字段。

验收：`scripts/ext2-check.mjs` 第四节把 CRX 内核真跑起来，在 guest 里执行
`echo hi > /tmp/a`、`mkdir /tmp/d`、`cp /root/count.s /tmp/c.s`、`rm /tmp/a`，
再把整盘字节交给 `e2fsck -fn`（干净）和 `debugfs`（能列出 guest 建的目录、能读出
guest 写的文件）。这一步不过，就说明 guest 侧的 ext2 写入还有对不上的地方。

另外：内核正文涨到 23.25 KiB，`KERNEL_TEXT_PAGES` 从 92 改到 93——不改的话
`installGuestKernel` 会因为装不下而直接 panic（`cannot install CRX kernel trap page`）。
