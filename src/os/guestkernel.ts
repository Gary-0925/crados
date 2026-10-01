// CRX 机器码内核 (Guest OS Kernel in CRX Machine Code)
//
// 运行在 supervisor 特权模式下。
// 内存布局 (Physical Memory Layout):
//   0x0000..0x003F : Kernel Control Block (KCB)
//     0x0000..0x001D : 引导标语 "crados 5.1\n"
//     0x001E : k_text_pfn (u16)，用户帧扫描上界
//     0x0020 : k_current_pid (u16)
//     0x0022 : k_current_slot (u16)
//     0x0024 : k_hz (u16)
//     0x0026 : k_switches (u16)
//     0x0028 : k_ticks_lo (u16)
//     0x002A : k_ticks_hi (u16)
//     0x002C : k_fg_pid (u16)
//     0x002E : k_time_slice (u16)
//     0x0030 : k_ivt_base (u16)
//     0x0032 : k_nproc (u16)
//     0x0034 : k_ram_size (u16)
//     0x0036 : k_page_size (u16)
//     0x0038 : k_pcb_base (u16 = 0x0100)
//     0x003A : k_pcb_size (u16 = 192)
//     0x003C : k_quantum (u16 = 5)
//     0x003E : k_first_user_pfn (u16 = 14)
//   0x0040 : v_dev (u16)，VFS 当前设备号
//   0x0048 : 路径指针模式，0 = 用户地址空间，1 = 内核
//   0x004A : inode 表字节偏移（宿主挂载前发布，ext2 层首次用到时从盘上校对）
//   0x004C : inode 总数（宿主在挂载前发布）
//   0x004E : 暂存区里装的是哪个块，0xFFFF = 内容不可信
//   0x0050..0x00BF : 系统调用与 ext2 层的暂存字（ext2 层独占哪些见它开头）
//   0x00C0..0x00DF : 挂载表，8 项 x 4 字节 (宿主设备, 宿主 inode, 被挂设备, 保留)
//   0x00E0..0x00FF : k_frame_bitmap (256 frames = 32 bytes)
//   0x0100..0x0CFF : Process Control Block Table (16 PCBs x 192 bytes)
//   0x1000..0x13FF : 设备暂存区 = 一个 1 KiB ext2 块（SCRATCH_BASE）
//   0x1400..0x17FF : host kmsg (u16 length, then text). Not a user page.
//   0x1800..0x19FF : host device catalog, 8 x 64 B. CRX formats lsblk queries.
//   0x1A00 起      : 用户页（宿主发布的首个用户帧 USER_FRAME_START = 26）
//   high frames    : CRX Kernel Text (KERNEL_TEXT_PAGES, physical direct map)
//   0xFF00..0xFFFF : MMIO，不是内存

import { M_EXEC, M_OWRITE, M_OEXEC, M_OREAD, M_READ, M_SETUID, M_STICKY, M_WRITE, UID_ROOT, UID_ROOT_NAME } from './fs'
import {
  BG_BLOCK_BITMAP,
  BG_FREE_BLOCKS,
  BG_FREE_INODES,
  BG_INODE_BITMAP,
  BG_INODE_TABLE,
  BG_USED_DIRS,
  BLOCK_SIZE,
  GDT_BLOCK,
  I_BLOCK,
  I_BLOCKS,
  I_DTIME,
  I_LINKS,
  I_SIZE,
  I_UID,
  ROOT_INO,
  SB_BLOCK,
  SB_FREE_BLOCKS,
  SB_FREE_INODES,
  SB_INODES,
} from './ext2'
import { SCRATCH_BASE } from '@/hw/ram'
import { PCB_EUID, PCB_UID } from './process'

// 机器码里的绝对字节偏移：超级块在块 1、块组描述符在块 2（都是 1 KiB 块）。
const SB_BYTE = SB_BLOCK * BLOCK_SIZE
const GDT_BYTE = GDT_BLOCK * BLOCK_SIZE
// 释放 inode 时要写的 i_dtime。本机没有墙钟，但 e2fsck 会把 links=0 的 inode 上
// 「小于 inode 总数」的 i_dtime 当成 orphan 链表的下一项（报“损坏的 orphan 链表”），
// 所以固定写一个 2001-09-09 的时间戳：0x3B9ACA00。
const I_DTIME_VALUE = 1000000000

export const GUEST_KERNEL_SOURCE = `.text
_start:
    cli
halt:
    hlt
    jmp halt

; 中断向量 0：系统调用入口 (sys 指令触发硬件特权切换进入此处)
syscall_entry:
    cli
    mov r4, 0
    stb [r4+0x0048], r4 ; 路径指针模式，0 表示用户虚拟地址
    cmp r0, 0           ; yield(2)
    je sys_yield
    cmp r0, 1           ; write(2)
    je sys_write
    cmp r0, 2           ; read(2)
    je sys_read
    cmp r0, 3           ; exit(2)
    je sys_exit
    cmp r0, 4           ; open(2)
    je sys_open
    cmp r0, 5           ; close(2)
    je sys_close
    cmp r0, 6           ; sleep(ticks)
    je sys_sleep
    cmp r0, 7           ; getpid(2)
    je sys_getpid
    cmp r0, 8           ; gethz(2)
    je sys_gethz
    cmp r0, 15          ; chmod(2)
    je sys_chmod
    cmp r0, 17          ; sync(2)
    je sys_sync
    cmp r0, 22          ; kill(2)
    je sys_kill
    cmp r0, 23          ; chdir(2)
    je sys_chdir
    cmp r0, 24          ; dup(2)
    je sys_dup
    cmp r0, 25          ; dup2(2)
    je sys_dup2
    cmp r0, 28          ; tcsetpgrp(2)
    je sys_tcsetpgrp
    cmp r0, 30          ; clock_gettime(2)
    je sys_time
    cmp r0, 29          ; page_alloc(vpn)
    je sys_page_alloc
    cmp r0, 31          ; page_free(vpn)
    je sys_page_free
    cmp r0, 32          ; block_read(dev, block, buffer)
    je sys_block_read
    cmp r0, 33          ; block_write(dev, block, buffer)
    je sys_block_write
    cmp r0, 11          ; getdents(path, buf, max)
    je sys_getdents
    cmp r0, 26          ; readview(kind, arg, buf)
    je sys_view
    cmp r0, 9           ; spawn
    je gp_spawn
    cmp r0, 10          ; wait
    je gp_wait
    cmp r0, 12          ; getcwd
    je gp_getcwd
    cmp r0, 13          ; unlink
    je gp_unlink
    cmp r0, 14          ; mkdir
    je gp_mkdir
    cmp r0, 16          ; rename
    je gp_rename
    cmp r0, 18          ; getenv
    je gp_getenv
    cmp r0, 20          ; mount
    je gp_mount
    cmp r0, 21          ; umount
    je gp_umount
    cmp r0, 27          ; assemble，编码器仍是宿主工具链
    je gp_assemble
    cmp r0, 34          ; sleep seconds
    je gp_sleep_sec
    cmp r0, 35          ; getuid → r0 真实 uid, r1 有效 uid
    je sys_getuid
    cmp r0, 36          ; ttyecho(r1)：r1=0 关闭回显（密码输入），否则恢复
    je sys_ttyecho
    cmp r0, 37
    je sys_password
    cmp r0, 38          ; spawnas(path, uid)：以账户身份启动登录 shell
    je gp_spawnas
    cmp r0, 39          ; chown(path, uid)
    je gp_chown

    mov r0, 65535
    iret

; write(fd, buf, len): 从当前 PCB 的 fd 表读取目标类型。
; tty/stdout/stderr 通过虚拟硬件 MMIO 端口输出；重定向到文件时走 ext2 层。
;   0xFF00 = tty stdout data, 0xFF01 = tty stderr data
sys_write:
    cmp r1, 7
    jgt write_bridge
    mov r4, r2          ; r4 = buffer
    mov r5, r3          ; r5 = requested length (0 means NUL terminated)

    ; r6 = current PCB + fd * 6
    mov r7, 0
    ldw r6, [r7+0x0022]
    mul r6, 192
    add r6, 0x0100
    mov r7, r1
    mul r7, 6
    add r6, r7
    mov r3, r6          ; r3 = PCB base + fd*6
    ldb r6, [r6+41]     ; fd.kind

    cmp r6, 2           ; stdout
    je write_stdout
    cmp r6, 3           ; stderr
    je write_stderr
    cmp r6, 4           ; /dev/tty
    je write_stdout
    cmp r6, 5           ; /dev/null
    je write_null
    cmp r6, 6           ; regular file
    jne write_bridge
    ldb r6, [r3+42]     ; fd.device
    push r3
    push r4
    push r5
    mov r1, r6
    call vfs_setdev     ; 目标是普通文件：设备切到它所在的盘（它破坏 r0、r4、r5）
    pop r5
    pop r4
    pop r3
    jmp write_file

write_bridge:
    mov r0, 65535
    iret

write_stdout:
    mov r7, 0xFF00
    jmp write_loop_init
write_stderr:
    mov r7, 0xFF01
    jmp write_loop_init

write_null:
    cmp r5, 0
    jne write_null_len
    mov r0, 0
write_null_scan:
    uldb r6, [r4+0]
    cmp r6, 0
    je write_done
    add r4, 1
    add r0, 1
    jmp write_null_scan
write_null_len:
    mov r0, r5
    iret

write_loop_init:
    mov r0, 0           ; bytes written
write_loop:
    cmp r5, 0
    je write_cstr
    cmp r0, r5
    je write_done
    uldb r6, [r4+0]
    jmp write_emit
write_cstr:
    uldb r6, [r4+0]
    cmp r6, 0
    je write_done
write_emit:
    stb [r7+0], r6
    add r4, 1
    add r0, 1
    jmp write_loop
write_done:
    iret

; open(path, flags): 路径、权限和目录项都在 gp_open。
sys_open:
    jmp gp_open

; 普通文件写入：ext2 inode 与块指针。一次系统调用最多写一个 1 KiB 块，
; 其余由调用方自己重试（libc 风格）。r3 = fd 记录，r4 = 用户缓冲区，r5 = 长度。
write_file:
    ldb r6, [r3+44]     ; flags: 0=只读，1=写，2=追加
    cmp r6, 0
    je write_file_failed
    push r1
    push r3
    push r4
    push r5
    ldb r1, [r3+43]     ; inode
    call may_write_ino
    pop r5
    pop r4
    pop r3
    pop r1
    cmp r0, 0
    jne write_file_failed

    ; 长度 0 表示以 NUL 结尾
    cmp r5, 0
    jne write_file_have_len
    mov r5, 0
    mov r6, r4
write_file_scan_len:
    uldb r7, [r6+0]
    cmp r7, 0
    je write_file_have_len
    add r6, 1
    add r5, 1
    jmp write_file_scan_len

write_file_have_len:
    mov r6, 0
    stw [r6+0x0060], r3 ; fd 记录
    stw [r6+0x0062], r4 ; 用户缓冲区游标
    stw [r6+0x0064], r5 ; 请求长度
    stw [r6+0x0074], r6 ; 已写字节（r6 = 0）
    ldb r1, [r3+43]     ; inode 号
    call vfs_inode
    cmp r0, 65280
    je write_file_failed
    mov r6, 0
    stw [r6+0x0068], r0 ; inode 字节偏移
    ldw r1, [r6+0x0060]
    ldb r1, [r1+43]
    call vfs_size
    cmp r0, 65535
    je write_file_failed
    mov r6, 0
    stw [r6+0x006A], r0 ; 旧的文件大小

; 每次落一个块：定位块、必要时分配、读进来、贴用户数据、整块写回。
write_file_block:
    mov r6, 0
    ldw r3, [r6+0x0060]
    ldw r7, [r3+45]     ; 当前文件偏移
    stw [r6+0x0066], r7
    ; 剩余 = 请求长度 - 已写
    ldw r3, [r6+0x0064]
    ldw r4, [r6+0x0074]
    sub r3, r4
    cmp r3, 0
    je write_file_done
    ; count = min(剩余, 1024 - 块内偏移)
    mov r5, r7
    mod r5, 1024
    stw [r6+0x006C], r5
    mov r4, 1024
    sub r4, r5
    cmp r3, r4
    jlt write_count_ok
    mov r3, r4
write_count_ok:
    stw [r6+0x006E], r3
    ; 逻辑块号 = 偏移 / 1024
    mov r4, r7
    div r4, 1024
    stw [r6+0x0070], r4
    ldw r1, [r6+0x0060]
    ldb r1, [r1+43]     ; inode 号
    ldw r2, [r6+0x0070]
    call vfs_ptr
    cmp r0, 65535
    je write_file_failed
    cmp r0, 0
    jne write_have_block
    ; 新块：本实现只往 12 个直接块里长
    ldw r4, [r6+0x0070]
    cmp r4, 12
    jgt write_file_failed
    call vfs_alloc_block
    cmp r0, 65535
    je write_file_failed
    mov r6, 0
    stw [r6+0x0072], r0
    ldw r1, [r6+0x0060]
    ldb r1, [r1+43]
    ldw r2, [r6+0x0070]
    ldw r3, [r6+0x0072]
    call vfs_set_ptr
    cmp r0, 0
    jne write_file_failed
    mov r6, 0
    ldw r2, [r6+0x0070]
    add r2, 1
    mul r2, 2               ; i_blocks：每 1 KiB 块算 2 个 512 字节扇区
    ldw r1, [r6+0x0060]
    ldb r1, [r1+43]
    call vfs_set_blocks
    cmp r0, 0
    jne write_file_failed
    mov r6, 0
    ldw r0, [r6+0x0072]
write_have_block:
    mov r6, 0
    stw [r6+0x0072], r0 ; 物理块号
    mov r1, r0
    call ext2_block
    cmp r0, 0
    jne write_file_failed
    ; 用户缓冲区 → 暂存区（块内偏移处）
    mov r6, 0
    ldw r2, [r6+0x0062]
    ldw r3, [r6+0x006E]
    ldw r4, [r6+0x006C]
    add r4, ${SCRATCH_BASE}
    mov r5, 0
write_file_copy:
    cmp r5, r3
    je write_file_commit
    uldb r7, [r2+0]
    stb [r4+0], r7
    add r2, 1
    add r4, 1
    add r5, 1
    jmp write_file_copy
write_file_commit:
    mov r6, 0
    ldw r1, [r6+0x0072]
    call ext2_commit
    cmp r0, 0
    jne write_file_failed

    ; 推进 fd 偏移、游标与总数；文件变大就更新 i_size
    mov r6, 0
    ldw r3, [r6+0x006E] ; 本次字节数
    ldw r4, [r6+0x0066] ; 旧偏移
    add r4, r3
    ldw r5, [r6+0x0060]
    stw [r5+45], r4
    ldw r2, [r6+0x0062]
    add r2, r3
    stw [r6+0x0062], r2
    ldw r2, [r6+0x0074]
    add r2, r3
    stw [r6+0x0074], r2
    ldw r7, [r6+0x006A] ; 旧大小
    cmp r4, r7
    jlt write_file_more
    je write_file_more
    ldw r1, [r6+0x0060]
    ldb r1, [r1+43]
    mov r2, r4
    call vfs_set_size
    cmp r0, 0
    jne write_file_failed
    mov r6, 0
    stw [r6+0x006A], r4
write_file_more:
    mov r6, 0
    ldw r3, [r6+0x0064]
    ldw r4, [r6+0x0074]
    cmp r4, r3
    jlt write_file_block
write_file_done:
    mov r6, 0
    ldw r0, [r6+0x0074]
    iret
write_file_failed:
    mov r0, 65535
    iret

; read(fd, buf, max)：普通文件由 ext2 层按块读，一次最多一个块。
sys_read:
    cmp r1, 7
    jgt read_bridge
    call current_pcb
    mov r4, r1
    mul r4, 6
    add r5, 41
    add r5, r4          ; r5 = fd 记录
    ldb r4, [r5+0]      ; kind
    cmp r4, 1           ; stdin
    je read_tty
    cmp r4, 4           ; /dev/tty
    je read_tty
    cmp r4, 5           ; /dev/null
    je read_eof
    cmp r4, 6           ; 普通文件
    jne read_bridge
    ldb r4, [r5+1]      ; 设备
    push r5
    mov r1, r4
    call vfs_setdev
    pop r5
read_native:
    mov r4, 0
    stw [r4+0x0050], r5 ; fd 记录
    stw [r4+0x0052], r2 ; 用户缓冲区
    stw [r4+0x0054], r3 ; 最大长度
    ldw r2, [r5+4]      ; 文件偏移
    stw [r4+0x0056], r2
    ldb r1, [r5+2]      ; inode 号
    call vfs_size
    cmp r0, 65535
    je read_failed
    mov r4, 0
    stw [r4+0x0058], r0 ; 文件大小
    ldw r6, [r4+0x0056]
    cmp r6, r0
    jlt read_have_data
    jmp read_eof
read_have_data:
    ; count = min(最大长度, 文件剩余, 到块尾)
    mov r7, r0
    sub r7, r6
    ldw r3, [r4+0x0054]
    cmp r3, r7
    jlt read_max_ok
    mov r3, r7
read_max_ok:
    mov r2, r6
    mod r2, 1024        ; 块内偏移
    mov r7, 1024
    sub r7, r2
    cmp r3, r7
    jlt read_block_ok
    mov r3, r7
read_block_ok:
    stw [r4+0x005C], r3 ; 本次读多少
    stw [r4+0x005E], r2 ; 块内偏移
    ldw r1, [r4+0x0050]
    ldb r1, [r1+2]      ; inode 号
    mov r2, r6
    div r2, 1024        ; 逻辑块号
    call vfs_ptr
    cmp r0, 65535
    je read_failed
    cmp r0, 0
    je read_failed      ; 洞：ext2 里读作 0，本系统不产生洞，按错误处理
    mov r1, r0
    call ext2_block
    cmp r0, 0
    jne read_failed
    ; 暂存区 → 用户缓冲区
    mov r4, 0
    ldw r2, [r4+0x0052]
    ldw r3, [r4+0x005C]
    ldw r6, [r4+0x005E]
    add r6, ${SCRATCH_BASE}
    mov r7, 0
read_copy:
    cmp r7, r3
    je read_update
    ldb r1, [r6+0]
    ustb [r2+0], r1
    add r6, 1
    add r2, 1
    add r7, 1
    jmp read_copy
read_update:
    mov r4, 0
    ldw r5, [r4+0x0050]
    ldw r6, [r4+0x0056]
    add r6, r3
    stw [r5+4], r6      ; fd.offset += 本次字节数
    mov r0, r3
    iret


; MMIO canonical TTY input:
;   0xFF10 status: 0 empty, 1 data, 2 EOF, 3 empty line
;   0xFF11 data: consume one byte / EOF marker / empty record
read_tty:
    mov r4, r2          ; user buffer
    mov r5, r3          ; max length
read_tty_retry:
    call current_pcb
    mov r6, 0
    stb [r5+20], r6     ; clear readStdin
    mov r7, 0xFF10
    ldb r6, [r7+0]
    cmp r6, 0
    je read_tty_block
    cmp r6, 2
    je read_tty_eof
    cmp r6, 3
    je read_tty_empty
    mov r0, 0
read_tty_loop:
    cmp r0, r5
    je read_tty_done
    ldb r6, [r7+0]
    cmp r6, 4           ; 行尾最后一字节：收下就停，别跨进下一行
    je read_tty_last
    cmp r6, 1
    jne read_tty_done
    ldb r6, [r7+1]
    ustb [r4+0], r6
    add r4, 1
    add r0, 1
    jmp read_tty_loop
read_tty_last:
    ldb r6, [r7+1]
    ustb [r4+0], r6
    add r4, 1
    add r0, 1
read_tty_done:
    ; 短行必须补 NUL，否则行缓冲里上一条更长的命令会粘在后面。
    cmp r0, r5
    je read_tty_full
    mov r6, 0
    ustb [r4+0], r6
read_tty_full:
    iret

read_tty_empty:
    ldb r6, [r7+1]      ; consume record
    mov r0, 0
    iret
read_tty_eof:
    ldb r6, [r7+1]      ; consume marker
    mov r0, 65535
    iret

read_tty_block:
    push r4
    push r5
    call current_pcb
    mov r6, 4           ; BLOCKED
    stb [r5+1], r6
    mov r6, 1
    stb [r5+20], r6     ; readStdin
    call do_schedule
    sched
    pop r5
    pop r4
    jmp read_tty_retry

read_eof:
    mov r0, 0
    iret
read_failed:
    mov r0, 65535
    iret
read_bridge:
    mov r0, 65535
    iret

; ---------------------------------------------------------------------------
; ext2 磁盘访问层（内核里唯一直接碰盘的地方）
;
; 几何缓存在 KCB：0x004A = inode 表的字节偏移，0x004C = inode 总数。第一次用到时从
; 块组描述符与超级块读出来。宿主在挂载前已经验过几何：块 1024 B、inode 128 B、
; 单块组、元数据在块 1..5、位图块 3 与 4、数据块从 37 起，所以这些数字在机器码
; 里就是常量（见 ext2.ts 的 ext2Layout）。
;
; 整块搬运走 0xFE00 块控制器：命令 4 = 盘 → 暂存区，命令 5 = 暂存区 → 盘。
; 暂存区只有一个块，读写交错时要小心：先读进来、就地改完、再整块写回。
; 0x004E 记住暂存区里是哪个块，0xFFFF 表示内容已不可信；换设备时清掉。
;
; 调用约定：r1/r2/r3 传参，r0 返回。**所有子程序都保留 r7**。各子程序破坏的
; 寄存器写在它们头上，用之前先看一眼。跨调用要活下来的中间值放栈上，或放本层
; 独占的 KCB 暂存字：
;   0x009C 0x009E 0x00A0 0x00A2 0x00A4 0x00A6
;   0x00A8 0x00AA 0x00AC 0x00AE 0x00B8 0x00BC 0x00BE
; 0x0050–0x009B（系统调用与策略）、0x00B0–0x00B6 与 0x00BA（策略）都不许碰。
; 0x00AC 是“正在提交的数据块号”：重新推导块号要读 inode，会把暂存区换掉，
; 所以改动暂存区之前先把块号记下来，提交时直接用。
;
; 盘上多字节字段是小端，而 ldw/stw 是大端，所以 u16 读写都要换字节；直接改
; 暂存区里盘上原始字节的地方（目录项标记、inode 清零）用 ldb/stb 手工拼小端。
;
; **16 位地址纪律**：寄存器只有 16 位，而盘有 1024 个块——块号 × 1024 一定越过 16 位。
; 所以「设备内字节偏移」只用来寻址元数据（超级块、组描述符、位图、inode 表，块 1..37，
; 偏移 < 64 KiB）；文件数据一律走「inode + 逻辑块号 → vfs_ptr → 物理块号 → ext2_block」，
; 块内偏移单独用 mod 1024 算。vfs_dblk 就是把「文件内数据偏移」换成物理块号的那一步。
; 千万不要把块号乘成字节偏移再交给 vfs_u8/vfs_u16。
;
; inode：mode@0x00 uid@0x02 size@0x04 links@0x1A i_block@0x28（12 个直接块 +
; 一个一级间接块，每项 4 字节取低半）。目录项：ino@0 rec_len@4 name_len@6
; file_type@7 name@8，靠 rec_len 串到 i_size 为止。

; vfs_setdev: r1 = 设备号。换设备必须丢掉暂存区与几何缓存。破坏 r0、r4、r5。
vfs_setdev:
    mov r4, 0
    stw [r4+0x0040], r1
    mov r5, 65535
    stw [r4+0x004E], r5
    stw [r4+0x004A], r5
    stw [r4+0x004C], r5
    ret

; vfs_geom: 需要时从盘上读几何。破坏 r0、r1、r3、r4、r5、r6。
vfs_geom:
    mov r4, 0
    ldw r3, [r4+0x004A]
    cmp r3, 0
    je vfs_geom_load
    cmp r3, 65535
    jne vfs_geom_ok
vfs_geom_load:
    mov r1, ${GDT_BYTE + BG_INODE_TABLE}
    call vfs_u16
    cmp r0, 0
    je vfs_geom_fail
    cmp r0, 65535
    je vfs_geom_fail
    mul r0, 1024        ; 组描述符里存的是块号，换成字节偏移
    mov r4, 0
    stw [r4+0x004A], r0
    mov r1, ${SB_BYTE + SB_INODES}
    call vfs_u16
    cmp r0, 0
    je vfs_geom_fail
    cmp r0, 65535
    je vfs_geom_fail
    mov r4, 0
    stw [r4+0x004C], r0
vfs_geom_ok:
    mov r0, 0
    ret
vfs_geom_fail:
    mov r0, 65535
    ret

; ext2_block: r1 = 块号 → 整块读进暂存区。r0 = 0 / 0xffff。
; 已在暂存区就跳过。破坏 r0、r3、r6；其余寄存器都不动。
ext2_block:
    mov r6, 0
    ldw r3, [r6+0x004E]
    cmp r3, r1
    je ext2_block_ok
    ldw r3, [r6+0x0040]
    mov r6, 0xFE00
    stw [r6+2], r3
    stw [r6+4], r1
    mov r3, ${SCRATCH_BASE}
    stw [r6+6], r3
    mov r3, 4           ; 命令 4 = 内核整块读
    stw [r6+0], r3
    ldw r0, [r6+8]
    cmp r0, 1
    jne ext2_block_fail
    mov r6, 0
    stw [r6+0x004E], r1
ext2_block_ok:
    mov r0, 0
    ret
ext2_block_fail:
    mov r6, 0
    mov r3, 65535
    stw [r6+0x004E], r3 ; 内容不可信
    mov r0, 65535
    ret

; ext2_commit: 把暂存区写回 r1 指定的块。r0 = 0 / 0xffff。破坏 r0、r3、r6。
; 暂存区里必须是这一块的内容：缓存对不上就直接失败，绝不把别的块写出去。
ext2_commit:
    mov r6, 0
    ldw r3, [r6+0x004E]
    cmp r3, r1
    jne ext2_commit_fail
    ldw r3, [r6+0x0040]
    mov r6, 0xFE00
    stw [r6+2], r3
    stw [r6+4], r1
    mov r3, ${SCRATCH_BASE}
    stw [r6+6], r3
    mov r3, 5           ; 命令 5 = 内核整块写
    stw [r6+0], r3
    ldw r0, [r6+8]
    cmp r0, 1
    jne ext2_commit_fail
    mov r6, 0
    stw [r6+0x004E], r1
    mov r0, 0
    ret
ext2_commit_fail:
    mov r6, 0
    mov r3, 65535
    stw [r6+0x004E], r3
    mov r0, 65535
    ret

; vfs_u8: r1 = 设备内字节偏移 → r0 = 该字节。保留 r2、r4、r7；破坏 r0、r1、r3、r5、r6。
vfs_u8:
    mov r5, r1
    div r1, 1024
    mod r5, 1024
    call ext2_block
    cmp r0, 0
    jne vfs_u_fail
    mov r3, ${SCRATCH_BASE}
    add r3, r5
    ldb r0, [r3+0]
    ret

; vfs_u16: r1 = 偏移 → r0 = 小端 u16。保留 r2、r4、r7；破坏 r0、r1、r3、r5、r6。
vfs_u16:
    mov r5, r1
    div r1, 1024
    mod r5, 1024
    call ext2_block
    cmp r0, 0
    jne vfs_u_fail
    mov r3, ${SCRATCH_BASE}
    add r3, r5
    ldw r0, [r3+0]      ; 暂存区里按大端读
    mov r5, r0
    and r5, 255
    shr r0, 8
    shl r5, 8
    or r0, r5           ; 换回小端
    ret

; vfs_w16: r1 = 偏移，r2 = 值 → r0 = 0 / 0xffff。保留 r4、r7。
vfs_w16:
    push r2
    cmp r1, 0
    jlt vfs_w16_fail
    mov r5, r1
    div r1, 1024
    mod r5, 1024
    call ext2_block
    cmp r0, 0
    jne vfs_w16_fail
    pop r2
    mov r3, r2
    and r3, 255
    shr r2, 8
    shl r3, 8
    or r2, r3           ; 写成小端
    mov r3, ${SCRATCH_BASE}
    add r3, r5
    stw [r3+0], r2
    call ext2_commit
    ret
vfs_w16_fail:
    pop r2
    jmp vfs_w_fail

; vfs_w8: r1 = 偏移，r2 = 值 → r0 = 0 / 0xffff。保留 r2、r4、r7。
vfs_w8:
    cmp r1, 0
    jlt vfs_w_fail
    mov r5, r1
    div r1, 1024
    mod r5, 1024
    call ext2_block
    cmp r0, 0
    jne vfs_w_fail
    mov r3, ${SCRATCH_BASE}
    add r3, r5
    stb [r3+0], r2
    call ext2_commit
    ret
vfs_w_fail:
vfs_u_fail:
    mov r0, 65535
    ret

; ino_in_range: r1 = inode 号 → r0 = 0 合法 / 0xFFFF 非法。
; 上界是宿主发布的 inode 总数（0 表示还没发布，一律非法）；inode 0、1 保留。
ino_in_range:
    cmp r1, 2
    jlt ino_in_range_no
    mov r0, 0
    ldw r0, [r0+0x004C]     ; inode 总数；借 r0 当临时量：调用方可能正用 r6 存结果
    cmp r0, 0
    je ino_in_range_no
    cmp r1, r0
    jgt ino_in_range_no
    mov r0, 0
    ret
ino_in_range_no:
    mov r0, 65535
    ret

; vfs_inode: r1 = inode 号 → r0 = inode 的绝对字节偏移（0xFF00 = 越界/无几何）。
; 破坏 r0、r1、r6、r7 之外什么都不动：r6 用于几何、r7 透传。
vfs_inode:
    push r1
    call vfs_geom
    cmp r0, 0
    jne vfs_inode_fail
    pop r1
    push r1
    call ino_in_range
    cmp r0, 0
    jne vfs_inode_fail
    pop r1
    mul r1, 128         ; 本实现的 inode 一律 128 字节
    mov r4, 0
    ldw r2, [r4+0x004A]
    add r1, r2
    mov r0, r1
    sub r0, 128         ; inode 从 1 开始编号
    ret
vfs_inode_fail:
    pop r1
    mov r0, 65280
    ret

; vfs_type: r1 = inode → r0 = 1 文件 / 2 目录 / 3 设备（i_mode 高 4 位）
vfs_type:
    call vfs_inode
    cmp r0, 65280
    je vfs_field_bad
    mov r1, r0
    call vfs_u16
    and r0, 61440       ; S_IFMT
    mov r1, r0
    mov r0, 1
    cmp r1, 32768       ; S_IFREG
    je vfs_type_ok
    mov r0, 2
    cmp r1, 16384       ; S_IFDIR
    je vfs_type_ok
    mov r0, 3           ; 设备（以及将来别的类型）
vfs_type_ok:
    ret

; vfs_mode: r1 = inode → r0 = 完整 i_mode
vfs_mode:
    call vfs_inode
    cmp r0, 65280
    je vfs_field_bad
    mov r1, r0
    call vfs_u16
    ret

; vfs_perms: r1 = inode → r0 = i_mode 低 12 位（含 setuid/setgid/sticky）
vfs_perms:
    call vfs_mode
    cmp r0, 65535
    je vfs_field_bad
    and r0, 4095
    ret

; vfs_size: r1 = inode → r0 = 文件大小低 16 位（本系统最大 64 KiB）
vfs_size:
    call vfs_inode
    cmp r0, 65280
    je vfs_field_bad
    add r0, ${I_SIZE}
    mov r1, r0
    call vfs_u16
    ret

; vfs_uid: r1 = inode → r0 = i_uid
vfs_uid:
    call vfs_inode
    cmp r0, 65280
    je vfs_field_bad
    add r0, ${I_UID}
    mov r1, r0
    call vfs_u16
    ret

; vfs_links: r1 = inode → r0 = i_links_count
vfs_links:
    call vfs_inode
    cmp r0, 65280
    je vfs_field_bad
    add r0, ${I_LINKS}
    mov r1, r0
    call vfs_u16
    ret

; vfs_ldev: r1 = inode → r0 = 设备号（i_block[0] 的低字节）
vfs_ldev:
    call vfs_inode
    cmp r0, 65280
    je vfs_field_bad
    add r0, ${I_BLOCK}
    mov r1, r0
    call vfs_u16
    and r0, 255
    ret
vfs_field_bad:
    mov r0, 65535
    ret

; ---- inode 字段写入：r1 = inode，r2 = 值，r0 = 0 / 0xffff ----

vfs_set_size:
    push r2
    call vfs_inode
    cmp r0, 65280
    je vfs_set_fail
    add r0, ${I_SIZE}
    mov r1, r0
    pop r2
    call vfs_w16
    ret

vfs_set_uid:
    push r2
    call vfs_inode
    cmp r0, 65280
    je vfs_set_fail
    add r0, ${I_UID}
    mov r1, r0
    pop r2
    call vfs_w16
    ret

vfs_set_links:
    push r2
    call vfs_inode
    cmp r0, 65280
    je vfs_set_fail
    add r0, ${I_LINKS}
    mov r1, r0
    pop r2
    call vfs_w16
    ret

; vfs_set_blocks: r1 = inode，r2 = i_blocks（512 字节扇区数）。低 16 位够用。
vfs_set_blocks:
    push r2
    call vfs_inode
    cmp r0, 65280
    je vfs_set_fail
    add r0, ${I_BLOCKS}
    mov r1, r0
    pop r2
    call vfs_w16
    ret

; vfs_set_mode: r1 = inode，r2 = 完整 i_mode（含类型位）
vfs_set_mode:
    push r2
    call vfs_inode
    cmp r0, 65280
    je vfs_set_fail
    mov r1, r0
    pop r2
    call vfs_w16
    ret
vfs_set_fail:
    mov r0, 65535
    ret

; vfs_ptr: r1 = inode，r2 = 逻辑块号 → r0 = 物理块号（0 = 未分配，0xFFFF = 出错）
; 间接路径会把间接块读进暂存区并顺手用掉 r2；调用方要用 r2 就先自己存好。
; 破坏 r0、r1、r2（间接路径）、r3、r5、r6；保留 r4、r7。
vfs_ptr:
    push r2
    call vfs_inode
    cmp r0, 65280
    je vfs_ptr_fail_pop
    mov r1, r0
    add r1, ${I_BLOCK}
    pop r2
    cmp r2, 12
    jlt vfs_ptr_direct
    push r2
    add r1, 48          ; i_block[12]：一级间接块
    call vfs_u16
    cmp r0, 65535
    je vfs_ptr_fail_pop
    cmp r0, 0
    je vfs_ptr_none_pop
    mov r1, r0
    call ext2_block         ; 间接块整块读进暂存区（破坏 r0、r3、r6）
    cmp r0, 0
    jne vfs_ptr_fail_pop
    pop r2
    sub r2, 12
    mul r2, 4
    add r2, ${SCRATCH_BASE}
    ldb r0, [r2+0]          ; 间接项的低 16 位（小端）
    ldb r1, [r2+1]
    shl r1, 8
    or r0, r1
    ret
vfs_ptr_direct:
    mul r2, 4
    add r1, r2
    call vfs_u16
    ret
vfs_ptr_none_pop:
    pop r2
vfs_ptr_none:
    mov r0, 0
    ret
vfs_ptr_fail_pop:
    pop r2
vfs_ptr_fail:
    mov r0, 65535
    ret

; vfs_set_ptr: r1 = inode，r2 = 逻辑块号，r3 = 物理块号 → r0 = 0 / 0xffff
; 只支持 12 个直接块的增长；间接块在建盘时已分配，这里只改其中一项。
; 破坏 r0、r1、r3、r5、r6；保留 r2、r4、r7。
vfs_set_ptr:
    push r3
    push r2
    call vfs_inode
    cmp r0, 65280
    je vfs_set_ptr_fail_both
    mov r1, r0
    add r1, ${I_BLOCK}
    pop r2
    pop r3
    cmp r2, 12
    jlt vfs_set_ptr_direct
    push r3
    push r2
    add r1, 48
    call vfs_u16          ; 间接块号
    cmp r0, 65535
    je vfs_set_ptr_fail_both
    cmp r0, 0
    je vfs_set_ptr_fail_both
    push r0                 ; 间接块号：提交时要用（ext2_commit 认暂存区里那块）
    mov r1, r0
    call ext2_block         ; 间接块整块读进暂存区（破坏 r0、r3、r6）
    cmp r0, 0
    jne vfs_set_ptr_fail_three
    pop r1                  ; 间接块号
    pop r2                  ; 逻辑块号
    pop r3                  ; 新块号
    push r1
    sub r2, 12
    mul r2, 4
    add r2, ${SCRATCH_BASE}
    mov r5, r3
    and r5, 255
    stb [r2+0], r5          ; 只改 4 字节项的低 16 位
    shr r3, 8
    stb [r2+1], r3
    pop r1
    call ext2_commit
    ret
vfs_set_ptr_fail_three:
    pop r0
    pop r0
    pop r0
    jmp vfs_set_ptr_fail
vfs_set_ptr_direct:
    mul r2, 4
    add r1, r2
    mov r2, r3
    call vfs_w16
    ret
vfs_set_ptr_fail_both:
    pop r2
    pop r3
vfs_set_ptr_fail:
    mov r0, 65535
    ret

; vfs_zero_ino: r1 = inode → inode 的 128 字节内容清零后写回。
; 破坏 r0、r1、r2、r3、r5、r6；保留 r4、r7。
vfs_zero_ino:
    call vfs_inode
    cmp r0, 65280
    je vfs_zero_ino_fail
    mov r4, 0
    stw [r4+0x009C], r0     ; inode 字节偏移
    mov r1, r0
    div r1, 1024
    stw [r4+0x009E], r1     ; 所在块号
    call ext2_block
    cmp r0, 0
    jne vfs_zero_ino_fail
    mov r4, 0
    ldw r3, [r4+0x009C]
    mod r3, 1024
    add r3, ${SCRATCH_BASE}
    mov r2, 0
    mov r5, 0
vfs_zero_ino_loop:
    cmp r5, 128
    je vfs_zero_ino_commit
    stb [r3+0], r2
    add r3, 1
    add r5, 1
    jmp vfs_zero_ino_loop
vfs_zero_ino_commit:
    mov r4, 0
    ldw r1, [r4+0x009E]
    call ext2_commit
    ret
vfs_zero_ino_fail:
    mov r0, 65535
    ret

; vfs_alloc_block: r0 = 新分配并清零的数据块号，0xffff = 失败。
; 位号 n 对应块 n + 1（1 KiB 块时 s_first_data_block = 1，规范如此）；位图里超出
; 块总数的位在格式化时已封成 1，扫到封口位自然停下。
; 破坏 r0–r6；保留 r7。暂存字：0x009C 位图块、0x009E 位号、0x00A0 字节偏移、
; 0x00A2 结果块号、0x00A4 位掩码。
vfs_alloc_block:
    mov r1, ${GDT_BYTE + BG_BLOCK_BITMAP}
    call vfs_u16
    cmp r0, 0
    je vfs_alloc_fail
    cmp r0, 65535
    je vfs_alloc_fail
    mov r4, 0
    stw [r4+0x009C], r0     ; 位图块号
    stw [r4+0x009E], r4     ; 位号 = 0
vfs_alloc_scan:
    mov r4, 0
    ldw r5, [r4+0x009E]
    cmp r5, 8192
    je vfs_alloc_fail
    jgt vfs_alloc_fail
    mov r6, r5
    mod r6, 8
    mov r7, 1
    shl r7, r6
    stw [r4+0x00A4], r7     ; 位掩码
    ldw r1, [r4+0x009C]
    mul r1, 1024
    div r5, 8
    add r1, r5
    stw [r4+0x00A0], r1     ; 位图字节偏移
    call vfs_u8
    cmp r0, 65535
    je vfs_alloc_fail
    mov r4, 0
    ldw r7, [r4+0x00A4]
    mov r6, r0
    and r6, r7
    cmp r6, 0
    jne vfs_alloc_next
    or r0, r7               ; 置位
    mov r2, r0
    mov r4, 0
    ldw r1, [r4+0x00A0]
    call vfs_w8
    cmp r0, 0
    jne vfs_alloc_fail
    ; 空闲块计数：超级块与块组描述符各减一
    mov r1, ${SB_BYTE + SB_FREE_BLOCKS}
    call vfs_u16
    cmp r0, 0
    je vfs_alloc_fail
    cmp r0, 65535
    je vfs_alloc_fail
    sub r0, 1
    mov r2, r0
    mov r1, ${SB_BYTE + SB_FREE_BLOCKS}
    call vfs_w16
    mov r1, ${GDT_BYTE + BG_FREE_BLOCKS}
    call vfs_u16
    cmp r0, 0
    je vfs_alloc_fail
    cmp r0, 65535
    je vfs_alloc_fail
    sub r0, 1
    mov r2, r0
    mov r1, ${GDT_BYTE + BG_FREE_BLOCKS}
    call vfs_w16
    ; 块号 = 位号 + 1：读进来清零再写回
    mov r4, 0
    ldw r1, [r4+0x009E]
    add r1, 1
    stw [r4+0x00A2], r1
    call ext2_block
    cmp r0, 0
    jne vfs_alloc_fail
    mov r5, ${SCRATCH_BASE}
    mov r2, 0
    mov r6, 0
vfs_alloc_zero:
    cmp r6, 1024
    je vfs_alloc_commit
    stb [r5+0], r2
    add r5, 1
    add r6, 1
    jmp vfs_alloc_zero
vfs_alloc_commit:
    mov r4, 0
    ldw r1, [r4+0x00A2]
    call ext2_commit
    cmp r0, 0
    jne vfs_alloc_fail
    mov r4, 0
    ldw r0, [r4+0x00A2]
    ret
vfs_alloc_next:
    mov r4, 0
    ldw r5, [r4+0x009E]
    add r5, 1
    stw [r4+0x009E], r5
    jmp vfs_alloc_scan
vfs_alloc_fail:
    mov r0, 65535
    ret

; vfs_free_block: r1 = 块号 → r0 = 0 / 0xffff。清位并同步空闲计数。
; 破坏 r0–r6；保留 r7。暂存字：0x009C 位图块、0x009E 字节偏移、0x00A0 掩码、
; 0x00A2 块号。
vfs_free_block:
    cmp r1, 1
    jlt vfs_free_b_fail     ; 块 0 永不分配
    mov r4, 0
    stw [r4+0x00A2], r1
    mov r1, ${GDT_BYTE + BG_BLOCK_BITMAP}
    call vfs_u16
    cmp r0, 0
    je vfs_free_b_fail
    cmp r0, 65535
    je vfs_free_b_fail
    mov r4, 0
    stw [r4+0x009C], r0
    ldw r1, [r4+0x00A2]
    sub r1, 1               ; 位号
    mov r5, r1
    mod r5, 8
    mov r6, 1
    shl r6, r5
    xor r6, 65535           ; 掩码（取反）
    stw [r4+0x00A0], r6
    div r1, 8
    ldw r2, [r4+0x009C]
    mul r2, 1024
    add r1, r2
    stw [r4+0x009E], r1
    call vfs_u8
    cmp r0, 65535
    je vfs_free_b_fail
    mov r4, 0
    ldw r6, [r4+0x00A0]
    and r0, r6
    mov r2, r0
    ldw r1, [r4+0x009E]
    call vfs_w8
    cmp r0, 0
    jne vfs_free_b_fail
    mov r1, ${SB_BYTE + SB_FREE_BLOCKS}
    call vfs_u16
    cmp r0, 65535
    je vfs_free_b_fail
    add r0, 1
    mov r2, r0
    mov r1, ${SB_BYTE + SB_FREE_BLOCKS}
    call vfs_w16
    mov r1, ${GDT_BYTE + BG_FREE_BLOCKS}
    call vfs_u16
    cmp r0, 65535
    je vfs_free_b_fail
    add r0, 1
    mov r2, r0
    mov r1, ${GDT_BYTE + BG_FREE_BLOCKS}
    call vfs_w16
    mov r0, 0
    ret
vfs_free_b_fail:
    mov r0, 65535
    ret

; vfs_alloc_inode: r0 = 新 inode 号（位号 + 1），0xffff = 失败。
; inode 内容清零、i_links_count 置 1；i_mode 与 i_uid 由调用方填。
; 破坏 r0–r6；保留 r7。暂存字：0x009C 位图块、0x009E 位号、0x00A0 字节偏移、
; 0x00A2 结果 inode、0x00A4 掩码。
vfs_alloc_inode:
    mov r1, ${GDT_BYTE + BG_INODE_BITMAP}
    call vfs_u16
    cmp r0, 0
    je vfs_alloc_i_fail
    cmp r0, 65535
    je vfs_alloc_i_fail
    mov r4, 0
    stw [r4+0x009C], r0
    stw [r4+0x009E], r4
vfs_alloc_i_scan:
    mov r4, 0
    ldw r5, [r4+0x009E]
    cmp r5, 8192
    je vfs_alloc_i_fail
    jgt vfs_alloc_i_fail
    mov r6, r5
    mod r6, 8
    mov r7, 1
    shl r7, r6
    stw [r4+0x00A4], r7
    ldw r1, [r4+0x009C]
    mul r1, 1024
    div r5, 8
    add r1, r5
    stw [r4+0x00A0], r1
    call vfs_u8
    cmp r0, 65535
    je vfs_alloc_i_fail
    mov r4, 0
    ldw r7, [r4+0x00A4]
    mov r6, r0
    and r6, r7
    cmp r6, 0
    jne vfs_alloc_i_next
    or r0, r7
    mov r2, r0
    mov r4, 0
    ldw r1, [r4+0x00A0]
    call vfs_w8
    cmp r0, 0
    jne vfs_alloc_i_fail
    mov r1, ${SB_BYTE + SB_FREE_INODES}
    call vfs_u16
    cmp r0, 0
    je vfs_alloc_i_fail
    cmp r0, 65535
    je vfs_alloc_i_fail
    sub r0, 1
    mov r2, r0
    mov r1, ${SB_BYTE + SB_FREE_INODES}
    call vfs_w16
    mov r1, ${GDT_BYTE + BG_FREE_INODES}
    call vfs_u16
    cmp r0, 0
    je vfs_alloc_i_fail
    cmp r0, 65535
    je vfs_alloc_i_fail
    sub r0, 1
    mov r2, r0
    mov r1, ${GDT_BYTE + BG_FREE_INODES}
    call vfs_w16
    mov r4, 0
    ldw r1, [r4+0x009E]
    add r1, 1               ; inode 号 = 位号 + 1
    stw [r4+0x00A2], r1
    call vfs_zero_ino
    cmp r0, 0
    jne vfs_alloc_i_fail
    mov r4, 0
    ldw r1, [r4+0x00A2]
    mov r2, 1
    call vfs_set_links      ; 新 inode 先记 1 个链接
    cmp r0, 0
    jne vfs_alloc_i_fail
    mov r4, 0
    ldw r0, [r4+0x00A2]
    ret
vfs_alloc_i_next:
    mov r4, 0
    ldw r5, [r4+0x009E]
    add r5, 1
    stw [r4+0x009E], r5
    jmp vfs_alloc_i_scan
vfs_alloc_i_fail:
    mov r0, 65535
    ret

; vfs_free_blocks: 释放 0x00A2 里那个 inode 的全部数据块（12 个直接块 + 一级
; 间接块里的 256 项 + 间接块自己）并把指针清零。r0 = 0 / 0xffff。
; 破坏 r0–r6；保留 r7。
; 暂存字 0x00A6 inode、0x00A8 逻辑块号、0x00AA inode 偏移——**不能**用
; 0x009C–0x00A4：vfs_free_block 是分配器家族，会把那一片全部覆盖掉。
vfs_free_blocks:
    mov r4, 0
    ldw r1, [r4+0x00A2]
    stw [r4+0x00A6], r1     ; 接口上 inode 走 0x00A2，内部改用 0x00A6
    call vfs_inode
    cmp r0, 65280
    je vfs_free_bl_err
    mov r4, 0
    stw [r4+0x00AA], r0     ; inode 偏移
    stw [r4+0x00A8], r4     ; 逻辑块号 = 0
vfs_free_bl_loop:
    mov r4, 0
    ldw r2, [r4+0x00A8]
    cmp r2, 268             ; 12 直接块 + 256 间接项
    je vfs_free_bl_tail
    ldw r1, [r4+0x00A6]
    call vfs_ptr
    cmp r0, 65535
    je vfs_free_bl_err
    cmp r0, 0
    je vfs_free_bl_next
    mov r1, r0
    call vfs_free_block
    cmp r0, 0
    jne vfs_free_bl_err
    mov r4, 0
    ldw r1, [r4+0x00A6]
    ldw r2, [r4+0x00A8]
    mov r3, 0
    call vfs_set_ptr        ; 指针清零
    cmp r0, 0
    jne vfs_free_bl_err
vfs_free_bl_next:
    mov r4, 0
    ldw r2, [r4+0x00A8]
    add r2, 1
    stw [r4+0x00A8], r2
    jmp vfs_free_bl_loop
vfs_free_bl_tail:
    ; 间接块自己也要还回去
    mov r4, 0
    ldw r1, [r4+0x00AA]
    add r1, ${I_BLOCK}
    add r1, 48
    call vfs_u16
    cmp r0, 65535
    je vfs_free_bl_err
    cmp r0, 0
    je vfs_free_bl_ok
    mov r1, r0
    call vfs_free_block
    cmp r0, 0
    jne vfs_free_bl_err
    mov r4, 0
    ldw r1, [r4+0x00AA]
    add r1, ${I_BLOCK}
    add r1, 48
    mov r2, 0
    call vfs_w16
    cmp r0, 0
    jne vfs_free_bl_err
vfs_free_bl_ok:
    ; 数据块都没了，i_blocks 也要归零（否则 e2fsck 会报 i_blocks 不对）
    mov r4, 0
    ldw r1, [r4+0x00A6]
    mov r2, 0
    call vfs_set_blocks
    cmp r0, 0
    jne vfs_free_bl_err
    mov r0, 0
    ret
vfs_free_bl_err:
    mov r0, 65535
    ret

; vfs_free_ino: r1 = inode → 释放数据块、清 inode 位图位、inode 内容清零。
; 破坏 r0–r6；保留 r7。
; 暂存字 0x00AE inode（本函数自己用）、0x009C 位图块、0x009E 字节偏移、0x00A0 掩码。
; inode 必须存在 0x00AE：vfs_free_blocks 往下会调 vfs_free_block，那是分配器家族，
; 会把 0x009C–0x00A4 整片写一遍，0x00A2 里就不再是 inode 了。
vfs_free_ino:
    mov r4, 0
    stw [r4+0x00AE], r1
    stw [r4+0x00A2], r1     ; vfs_free_blocks 的接口就是 0x00A2
    call vfs_free_blocks
    cmp r0, 0
    jne vfs_free_i_fail
    mov r4, 0
    ldw r1, [r4+0x00AE]
    sub r1, 1               ; 位号 = inode - 1
    mov r5, r1
    mod r5, 8
    mov r6, 1
    shl r6, r5
    xor r6, 65535
    stw [r4+0x00A0], r6
    mov r1, ${GDT_BYTE + BG_INODE_BITMAP}
    call vfs_u16
    cmp r0, 0
    je vfs_free_i_fail
    cmp r0, 65535
    je vfs_free_i_fail
    mov r4, 0
    stw [r4+0x009C], r0
    ldw r1, [r4+0x00AE]
    sub r1, 1
    div r1, 8
    ldw r2, [r4+0x009C]
    mul r2, 1024
    add r1, r2
    stw [r4+0x009E], r1
    call vfs_u8
    cmp r0, 65535
    je vfs_free_i_fail
    mov r4, 0
    ldw r6, [r4+0x00A0]
    and r0, r6
    mov r2, r0
    ldw r1, [r4+0x009E]
    call vfs_w8
    cmp r0, 0
    jne vfs_free_i_fail
    mov r1, ${SB_BYTE + SB_FREE_INODES}
    call vfs_u16
    cmp r0, 65535
    je vfs_free_i_fail
    add r0, 1
    mov r2, r0
    mov r1, ${SB_BYTE + SB_FREE_INODES}
    call vfs_w16
    mov r1, ${GDT_BYTE + BG_FREE_INODES}
    call vfs_u16
    cmp r0, 65535
    je vfs_free_i_fail
    add r0, 1
    mov r2, r0
    mov r1, ${GDT_BYTE + BG_FREE_INODES}
    call vfs_w16
    ; 目录还要把 bg_used_dirs_count 减回去（清零 inode 之前先确认类型）
    mov r4, 0
    ldw r1, [r4+0x00AE]
    call vfs_type
    cmp r0, 2
    jne vfs_free_i_notdir
    mov r1, ${GDT_BYTE + BG_USED_DIRS}
    call vfs_u16
    cmp r0, 0
    je vfs_free_i_notdir
    cmp r0, 65535
    je vfs_free_i_notdir
    sub r0, 1
    mov r2, r0
    mov r1, ${GDT_BYTE + BG_USED_DIRS}
    call vfs_w16
vfs_free_i_notdir:
    mov r4, 0
    ldw r1, [r4+0x00AE]
    call vfs_zero_ino
    cmp r0, 0
    jne vfs_free_i_fail     ; 清零写盘失败
    ; 删除过的 inode 要留一个像样的 i_dtime（低 16 位 + 高 16 位各写一次）
    mov r4, 0
    ldw r1, [r4+0x00AE]
    call vfs_inode
    cmp r0, 65280
    je vfs_free_i_fail      ; 0xFF00 = 拿不到 inode 偏移
    add r0, ${I_DTIME}
    mov r1, r0
    mov r2, ${I_DTIME_VALUE & 0xffff}
    call vfs_w16
    cmp r0, 0
    jne vfs_free_i_fail
    mov r4, 0
    ldw r1, [r4+0x00AE]
    call vfs_inode
    cmp r0, 65280
    je vfs_free_i_fail
    add r0, ${I_DTIME + 2}
    mov r1, r0
    mov r2, ${I_DTIME_VALUE >>> 16}
    call vfs_w16
    ret
vfs_free_i_fail:
    mov r0, 65535
    ret

; vfs_dblk: r1 = inode，r2 = 文件内数据偏移 → r0 = 物理块号（0 = 洞，0xffff = 出错）。
; 只做「偏移 → 逻辑块号」这一步，块号原样返回：把它乘成字节偏移会越过 16 位。
; 破坏 r0、r1、r2、r3、r5、r6；保留 r4、r7。
vfs_dblk:
    div r2, 1024            ; 逻辑块号（目录最大 1024，多出来的位在这里丢掉也无妨）
    call vfs_ptr
    ret

; vfs_dirent: r1 = 目录 inode，r2 = 目录数据里的字节偏移。
;   r0 = 子 inode（0 = 空槽），r5 = 名字在暂存区里的地址，r6 = 名字字节数，
;   r7 = 下一条记录的字节偏移（同样是数据偏移）；出错时 r0 = 0xffff。
; 破坏 r0、r1、r3、r5、r6；保留 r2、r4（并写返回值 r7）。暂存字：0x009C 子 inode。
vfs_dirent:
    push r2                 ; 数据偏移，返回时还要用
    mov r3, r2
    mod r3, 1024            ; 块内偏移
    push r3
    call vfs_dblk           ; r0 = 物理块号
    cmp r0, 65535
    je vfs_dirent_fail_pop
    cmp r0, 0
    je vfs_dirent_fail_pop  ; 洞
    mov r1, r0
    call ext2_block         ; 块读进暂存区（破坏 r0、r3、r6）
    cmp r0, 0
    jne vfs_dirent_fail_pop
    pop r3                  ; 块内偏移
    add r3, ${SCRATCH_BASE}          ; 记录在暂存区里的地址
    ldb r0, [r3+0]          ; ino（盘上小端）
    ldb r1, [r3+1]
    shl r1, 8
    or r0, r1
    mov r4, 0
    stw [r4+0x009C], r0
    ldb r1, [r3+4]          ; rec_len
    ldb r0, [r3+5]
    shl r0, 8
    or r1, r0
    cmp r1, 8
    jlt vfs_dirent_fail_pop ; 记录至少 8 字节
    mov r7, r1              ; rec_len（后面每个子程序都保留 r7）
    ldb r6, [r3+6]          ; name_len
    mov r5, r3
    add r5, 8               ; 名字在暂存区里的地址
    mov r4, 0
    ldw r0, [r4+0x009C]
    pop r2                  ; 数据偏移
    add r7, r2              ; 下一条记录的数据偏移
    cmp r0, 0
    jne vfs_dirent_done
    mov r6, 0               ; 空槽：名字长度无意义
vfs_dirent_done:
    ret
vfs_dirent_fail_pop:
    pop r3                  ; 丢掉块内偏移
    pop r2                  ; 数据偏移
vfs_dirent_fail:
    mov r0, 65535
    ret

; vfs_lookup: r1 = 目录 inode，r2 = 用户态路径分量 → r0 = 子 inode（0xffff = 没找到）
; 破坏 r0–r6；保留 r7。暂存字：0x00A2 目录 inode、0x00A4 目录大小、0x00A6 遍历偏移、
; 0x00A8 候选 inode、0x00AA 路径分量。
vfs_lookup:
    mov r4, 0
    stw [r4+0x00A2], r1
    stw [r4+0x00AA], r2
    stw [r4+0x00A6], r4     ; 遍历偏移 = 0
    mov r1, r1
    call vfs_size
    cmp r0, 65535
    je vfs_lookup_fail
    mov r4, 0
    stw [r4+0x00A4], r0     ; 目录字节数
vfs_lookup_entry:
    mov r4, 0
    ldw r2, [r4+0x00A6]
    ldw r3, [r4+0x00A4]
    cmp r2, r3
    jgt vfs_lookup_fail
    je vfs_lookup_fail
    ldw r1, [r4+0x00A2]
    call vfs_dirent
    cmp r0, 65535
    je vfs_lookup_fail
    cmp r7, 0
    je vfs_lookup_fail
    mov r4, 0
    stw [r4+0x00A6], r7     ; 下一条记录
    stw [r4+0x00A8], r0     ; 候选 inode
    cmp r0, 0
    je vfs_lookup_entry     ; 空槽
    ldw r2, [r4+0x00AA]     ; 路径分量游标
    mov r3, 0               ; 已比较的字节数
vfs_lookup_name:
    cmp r3, r6
    je vfs_lookup_name_end
    mov r1, r2
    mov r2, 0
    push r3
    push r1
    call path_load
    pop r1
    pop r3
    mov r2, r1
    cmp r0, 0
    je vfs_lookup_retry     ; 路径分量比名字短
    cmp r0, 47
    je vfs_lookup_retry     ; 分量到此结束：不是这个名字
    ldb r1, [r5+0]
    cmp r1, r0
    jne vfs_lookup_retry
    add r5, 1
    add r2, 1
    add r3, 1
    jmp vfs_lookup_name
vfs_lookup_retry:
    jmp vfs_lookup_entry
vfs_lookup_name_end:
    ; 名字长度相同还不够：路径分量必须正好在这里结束
    mov r1, r2
    mov r2, 0
    push r1
    call path_load
    pop r2
    cmp r0, 0
    je vfs_lookup_child
    cmp r0, 47
    jne vfs_lookup_retry
vfs_lookup_child:
    mov r4, 0
    ldw r1, [r4+0x00A8]
    call ino_in_range
    cmp r0, 0
    jne vfs_lookup_retry
    mov r4, 0
    ldw r0, [r4+0x00A8]
    ret
vfs_lookup_fail:
    mov r0, 65535
    ret

; vfs_cross_down: 0x00A2 若是挂载点，就换到被挂设备的根（0x00A2 就地改写）。
; 挂载表项：宿主设备、宿主 inode、被挂设备、保留字节（8 项，从 0x00C0 起）。
vfs_cross_down:
    mov r4, 0
    ldw r6, [r4+0x0040]     ; 宿主设备
    ldw r7, [r4+0x00A2]     ; 宿主 inode
    mov r4, 0x00C0
vfs_down_scan:
    cmp r4, 0x00E0
    je vfs_down_done
    ldb r5, [r4+2]
    cmp r5, 0
    je vfs_down_next        ; 空槽
    ldb r5, [r4+0]
    cmp r5, r6
    jne vfs_down_next
    ldb r5, [r4+1]
    cmp r5, r7
    jne vfs_down_next
    ldb r1, [r4+2]          ; 被挂设备
    call vfs_setdev
    mov r4, 0
    mov r5, ${ROOT_INO}
    stw [r4+0x00A2], r5
    ret
vfs_down_next:
    add r4, 4
    jmp vfs_down_scan
vfs_down_done:
    ret

; vfs_cross_up: 0x00A2 换成父目录。ext2 里父目录就是目录项 “..”；到了本设备的根
; （inode 2）若是被挂设备，就回到宿主设备的那个挂载点。
; 破坏 r0–r6；保留 r7。暂存字：0x00A4 目录大小、0x00A6 遍历偏移、0x00A8 目录 inode。
vfs_cross_up:
    mov r4, 0
    ldw r7, [r4+0x00A2]
    cmp r7, ${ROOT_INO}
    jne vfs_up_parent
    ldw r6, [r4+0x0040]     ; 当前（被挂）设备
    mov r4, 0x00C0
vfs_up_mnt:
    cmp r4, 0x00E0
    je vfs_up_root
    ldb r5, [r4+2]
    cmp r5, r6
    jne vfs_up_mnt_next
    ldb r6, [r4+1]          ; 宿主侧的挂载点 inode
    ldb r1, [r4+0]
    push r6
    call vfs_setdev
    pop r6
    mov r4, 0
    stw [r4+0x00A2], r6
    ret
vfs_up_mnt_next:
    add r4, 4
    jmp vfs_up_mnt
vfs_up_root:
    ret
vfs_up_parent:
    mov r4, 0
    stw [r4+0x00A8], r7     ; 当前目录 inode
    stw [r4+0x00A6], r4     ; 偏移 = 0
    mov r1, r7
    call vfs_size
    cmp r0, 65535
    je vfs_up_fail
    mov r4, 0
    stw [r4+0x00A4], r0
vfs_up_entry:
    mov r4, 0
    ldw r2, [r4+0x00A6]
    ldw r3, [r4+0x00A4]
    cmp r2, r3
    jgt vfs_up_fail
    je vfs_up_fail
    ldw r1, [r4+0x00A8]
    call vfs_dirent
    cmp r0, 65535
    je vfs_up_fail
    cmp r7, 0
    je vfs_up_fail
    mov r4, 0
    stw [r4+0x00A6], r7
    cmp r0, 0
    je vfs_up_entry         ; 空槽
    cmp r6, 2               ; 名字必须正好是 “..”
    jne vfs_up_entry
    ldb r1, [r5+0]
    cmp r1, 46
    jne vfs_up_entry
    ldb r1, [r5+1]
    cmp r1, 46
    jne vfs_up_entry
    mov r4, 0
    stw [r4+0x00A2], r0
    ret
vfs_up_fail:
    mov r0, 65535
    ret

; vfs_trunc: r1 = inode → 丢掉全部数据块并把 i_size 归零。r0 = 0 / 0xffff。
; inode 必须存在 0x00AE：vfs_free_blocks 会调分配器家族，把 0x009C–0x00A4 整片写掉。
vfs_trunc:
    mov r4, 0
    stw [r4+0x00AE], r1
    stw [r4+0x00A2], r1
    call vfs_free_blocks
    cmp r0, 0
    jne vfs_trunc_fail
    mov r4, 0
    ldw r1, [r4+0x00AE]
    mov r2, 0
    call vfs_set_size
    ret
vfs_trunc_fail:
    mov r0, 65535
    ret

; vfs_add_dirent: r1 = 目录 inode，r2 = 用户态名字指针，r3 = 名字长度；
; KCB 0x00B8 = 子 inode，0x00BC = 盘上类型（1 文件 / 2 目录 / 3 设备）。
; 在目录里找一条放得下的现成记录：空槽就整条占用，已用记录就把它收紧到实际
; 长度、空隙留给新项。目录不增长，一块满了就返回 0xffff。
; 破坏 r0–r6；保留 r7。暂存字：0x00A2 目录、0x00A4 目录大小、0x00A6 游标、
; 0x00A8 need、0x00AA 名字指针、0x00AE 名字长度、0x00B8 子 inode、0x00BC 类型、
; 0x00BE 命中记录偏移、0x009C 新项 rec_len、0x009E 新项偏移、0x00A0 旧项新 rec_len。
vfs_add_dirent:
    mov r4, 0
    stw [r4+0x00A2], r1
    stw [r4+0x00AA], r2
    stw [r4+0x00AE], r3
    mov r5, r3
    add r5, 11
    and r5, 65532           ; need = 8 + 名字长度，4 字节对齐
    stw [r4+0x00A8], r5
    ldw r1, [r4+0x00A2]
    call vfs_size
    cmp r0, 65535
    je vfs_add2_fail
    mov r4, 0
    stw [r4+0x00A4], r0     ; 目录字节数
    stw [r4+0x00A6], r4     ; 游标 = 0
vfs_add2_scan:
    mov r4, 0
    ldw r2, [r4+0x00A6]
    ldw r3, [r4+0x00A4]
    cmp r2, r3
    jgt vfs_add2_fail
    je vfs_add2_fail
    stw [r4+0x00BE], r2     ; 当前记录偏移
    ldw r1, [r4+0x00A2]
    call vfs_dirent          ; r0 = ino，r6 = 名字长度，r7 = 下一条
    cmp r0, 65535
    je vfs_add2_fail
    cmp r7, 0
    je vfs_add2_fail
    mov r4, 0
    stw [r4+0x00A6], r7     ; 游标前进
    ldw r2, [r4+0x00BE]
    mov r3, r7
    sub r3, r2              ; 这一条的 rec_len
    cmp r0, 0
    jne vfs_add2_used
    ; 空槽：整条都能用
    ldw r2, [r4+0x00A8]
    cmp r3, r2
    jlt vfs_add2_scan
    stw [r4+0x009C], r3     ; 新项 rec_len = 整条
    ldw r2, [r4+0x00BE]
    stw [r4+0x009E], r2     ; 新项就放在这一条的起点
    stw [r4+0x00A0], r0     ; 0 = 没有旧项要收紧
    jmp vfs_add2_write
vfs_add2_used:
    mov r2, r6
    add r2, 11
    and r2, 65532           ; 这一条实际用掉的长度
    sub r3, r2              ; 空余空间
    ldw r5, [r4+0x00A8]     ; need
    cmp r3, r5
    jlt vfs_add2_scan
    stw [r4+0x00A0], r2     ; 旧项收紧到实际长度
    stw [r4+0x009C], r3     ; 新项 rec_len = 原记录剩下的全部空间（链条不能断）
    ldw r5, [r4+0x00BE]
    add r5, r2              ; 新项 = 当前记录 + 收紧后的长度
    stw [r4+0x009E], r5
vfs_add2_write:
    mov r4, 0
    ldw r1, [r4+0x00A2]
    ldw r2, [r4+0x00BE]
    call vfs_dblk
    cmp r0, 65535
    je vfs_add2_fail
    cmp r0, 0
    je vfs_add2_fail        ; 洞
    mov r4, 0
    stw [r4+0x00AC], r0     ; 提交时不再重推块号（那会读 inode、换掉暂存区）
    mov r1, r0
    call ext2_block
    cmp r0, 0
    jne vfs_add2_fail
    ; 旧项收紧（空槽跳过）
    mov r4, 0
    ldw r2, [r4+0x00A0]
    cmp r2, 0
    je vfs_add2_place
    ldw r1, [r4+0x00BE]
    mod r1, 1024
    add r1, ${SCRATCH_BASE}
    mov r3, r1
    add r3, 4
    stb [r3+0], r2          ; rec_len 小端低字节
    shr r2, 8
    stb [r3+1], r2
vfs_add2_place:
    mov r4, 0
    ldw r5, [r4+0x009E]
    mod r5, 1024
    add r5, ${SCRATCH_BASE}          ; 新记录在暂存区里的地址
    ldw r3, [r4+0x00B8]     ; 子 inode
    stb [r5+0], r3
    shr r3, 8
    stb [r5+1], r3
    ldw r3, [r4+0x009C]     ; rec_len
    stb [r5+4], r3
    shr r3, 8
    stb [r5+5], r3
    ldw r3, [r4+0x00AE]     ; name_len
    stb [r5+6], r3
    ldw r3, [r4+0x00BC]     ; type
    stb [r5+7], r3
    ldw r2, [r4+0x00AE]     ; 名字逐字节拷进去（用户地址空间）
    ldw r3, [r4+0x00AA]
    add r5, 8
vfs_add2_name:
    cmp r2, 0
    je vfs_add2_commit
    uldb r6, [r3+0]
    stb [r5+0], r6
    add r5, 1
    add r3, 1
    sub r2, 1
    jmp vfs_add2_name
vfs_add2_commit:
    mov r4, 0
    ldw r1, [r4+0x00AC]
    call ext2_commit
    cmp r0, 0
    jne vfs_add2_fail
    ldw r3, [r4+0x00BC]
    cmp r3, 2
    jne vfs_add2_ok           ; 只有新项是目录时父目录链接数才 +1
    ldw r1, [r4+0x00A2]
    call vfs_links
    cmp r0, 65535
    je vfs_add2_fail
    add r0, 1
    mov r2, r0
    mov r4, 0
    ldw r1, [r4+0x00A2]
    call vfs_set_links
    cmp r0, 0
    jne vfs_add2_fail
vfs_add2_ok:
    mov r0, 0
    ret
vfs_add2_fail:
    mov r0, 65535
    ret

; vfs_del_dirent: r1 = 目录 inode，r2 = 用户态名字指针，r3 = 名字长度。
; 清掉匹配的目录项（ino = 0、name_len = 0），并把它并进前一条的 rec_len。
; 破坏 r0–r6；保留 r7。暂存字：0x00A2 目录、0x00A4 目录大小、0x00A6 游标、
; 0x00A8 前一条的偏移、0x00AA 名字指针、0x00AE 名字长度、0x00BE 当前记录偏移。
vfs_del_dirent:
    mov r4, 0
    stw [r4+0x00A2], r1
    stw [r4+0x00AA], r2
    stw [r4+0x00AE], r3
    stw [r4+0x00A8], r4     ; 前一条 = 0
    ldw r1, [r4+0x00A2]
    call vfs_size
    cmp r0, 65535
    je vfs_del2_fail
    mov r4, 0
    stw [r4+0x00A4], r0
    stw [r4+0x00A6], r4     ; 游标 = 0
vfs_del2_scan:
    mov r4, 0
    ldw r2, [r4+0x00A6]
    ldw r3, [r4+0x00A4]
    cmp r2, r3
    jgt vfs_del2_fail
    je vfs_del2_fail
    stw [r4+0x00BE], r2
    ldw r1, [r4+0x00A2]
    call vfs_dirent          ; r0 = ino，r5 = 名字，r6 = 名字长度，r7 = 下一条
    cmp r0, 65535
    je vfs_del2_fail
    cmp r7, 0
    je vfs_del2_fail
    mov r4, 0
    cmp r0, 0
    je vfs_del2_next       ; 空槽
    ; 名字长度相等且逐字节相同才算命中
    ldw r2, [r4+0x00AE]
    cmp r6, r2
    jne vfs_del2_next
    ldw r2, [r4+0x00AA]
    mov r3, 0
vfs_del2_name:
    cmp r3, r6
    je vfs_del2_hit
    uldb r0, [r2+0]
    ldb r1, [r5+0]
    cmp r0, r1
    jne vfs_del2_next
    add r2, 1
    add r5, 1
    add r3, 1
    jmp vfs_del2_name
vfs_del2_next:
    mov r4, 0
    ldw r2, [r4+0x00BE]
    stw [r4+0x00A8], r2     ; 前一条 = 当前条
    stw [r4+0x00A6], r7     ; 游标前进
    jmp vfs_del2_scan
vfs_del2_hit:
    ; 命中：读这块，把 ino 与 name_len 清零，并把它并进前一条
    mov r4, 0
    ldw r1, [r4+0x00A2]
    ldw r2, [r4+0x00BE]
    call vfs_dblk
    cmp r0, 65535
    je vfs_del2_fail
    cmp r0, 0
    je vfs_del2_fail        ; 洞
    mov r4, 0
    stw [r4+0x00AC], r0     ; 提交时不再重推块号
    mov r1, r0
    call ext2_block
    cmp r0, 0
    jne vfs_del2_fail
    mov r4, 0
    ldw r5, [r4+0x00BE]
    mod r5, 1024
    add r5, ${SCRATCH_BASE}
    mov r3, 0
    stb [r5+0], r3          ; ino = 0
    stb [r5+1], r3
    stb [r5+6], r3          ; name_len = 0
    stb [r5+7], r3          ; type = 0
    ; 前一条的 rec_len += 这一条的 rec_len（两条必须同块）
    ldw r1, [r4+0x00A8]
    cmp r1, 0
    je vfs_del2_commit      ; 第一条记录没有前项可并
    ldw r2, [r4+0x00BE]
    mov r3, r1
    div r3, 1024            ; 前一条的数据块号
    mov r5, r2
    div r5, 1024            ; 这一条的数据块号
    cmp r3, r5
    jne vfs_del2_commit     ; 跨块就不并（记录不跨块，正常不会发生）
    ldw r3, [r4+0x00A6]     ; 下一条记录
    sub r3, r2              ; 这一条的 rec_len
    mov r5, r2
    sub r5, r1              ; 前一条原有 rec_len
    add r3, r5              ; 合并后的 rec_len
    and r1, 1023
    add r1, ${SCRATCH_BASE}
    mov r2, r3
    and r2, 255
    stb [r1+4], r2
    shr r3, 8
    stb [r1+5], r3
vfs_del2_commit:
    mov r4, 0
    ldw r1, [r4+0x00AC]
    call ext2_commit
    ret
vfs_del2_fail:
    mov r0, 65535
    ret

; vfs_dir_init: r1 = 新目录 inode，r2 = 父目录 inode。分配一个数据块，写上 “.” 与
; “..”（一条记录占满整块），i_size = 1024，i_links = 2，i_blocks = 2。
; r0 = 0 / 0xffff。破坏 r0–r6；保留 r7。
; 暂存字 0x00A6 目录、0x00A8 父目录、0x00AA 新块——**不能**用 0x009C–0x00A4，
; 那是分配器的状态字，vfs_alloc_block 会把它们覆盖掉。
vfs_dir_init:
    mov r4, 0
    stw [r4+0x00A6], r1
    stw [r4+0x00A8], r2
    call vfs_alloc_block
    cmp r0, 65535
    je vfs_dir_init_fail
    mov r4, 0
    stw [r4+0x00AA], r0
    ldw r1, [r4+0x00A6]
    mov r2, 0
    mov r3, r0
    call vfs_set_ptr        ; 逻辑块 0 → 新块
    cmp r0, 0
    jne vfs_dir_init_fail
    mov r4, 0
    ldw r1, [r4+0x00AA]
    call ext2_block
    cmp r0, 0
    jne vfs_dir_init_fail
    mov r5, ${SCRATCH_BASE}
    mov r4, 0
    ldw r2, [r4+0x00A6]     ; “.”：ino = 自己
    stb [r5+0], r2
    shr r2, 8
    stb [r5+1], r2
    mov r2, 12
    stb [r5+4], r2          ; rec_len = 12
    mov r2, 0
    stb [r5+5], r2
    mov r2, 1
    stb [r5+6], r2          ; name_len = 1
    mov r2, 2
    stb [r5+7], r2          ; type = 目录
    mov r2, 46
    stb [r5+8], r2          ; “.”
    mov r4, 0
    ldw r2, [r4+0x00A8]     ; “..”：ino = 父目录
    stb [r5+12], r2
    shr r2, 8
    stb [r5+13], r2
    mov r2, 1012
    stb [r5+16], r2         ; rec_len = 1012
    mov r2, 3
    stb [r5+17], r2         ; 1012 的高字节
    mov r2, 2
    stb [r5+18], r2
    mov r2, 2
    stb [r5+19], r2
    mov r2, 46
    stb [r5+20], r2
    stb [r5+21], r2
    mov r4, 0
    ldw r1, [r4+0x00AA]
    call ext2_commit
    cmp r0, 0
    jne vfs_dir_init_fail
    mov r4, 0
    ldw r1, [r4+0x00A6]
    mov r2, 1024
    call vfs_set_size
    cmp r0, 0
    jne vfs_dir_init_fail
    mov r4, 0
    ldw r1, [r4+0x00A6]
    mov r2, 2
    call vfs_set_links
    cmp r0, 0
    jne vfs_dir_init_fail
    mov r4, 0
    ldw r1, [r4+0x00A6]
    mov r2, 2
    call vfs_set_blocks
    cmp r0, 0
    jne vfs_dir_init_fail
    mov r1, ${GDT_BYTE + BG_USED_DIRS}
    call vfs_u16
    cmp r0, 65535
    je vfs_dir_init_fail
    add r0, 1
    mov r2, r0
    mov r1, ${GDT_BYTE + BG_USED_DIRS}
    call vfs_w16
    ret
vfs_dir_init_fail:
    mov r0, 65535
    ret

; vfs_unlink_ino: r1 = inode → 链接数 -1；减到 0 就释放数据块与 inode。
; 破坏 r0–r6；保留 r7。
vfs_unlink_ino:
    mov r4, 0
    stw [r4+0x00A2], r1
    call vfs_links
    cmp r0, 65535
    je vfs_unlink_ino_fail
    cmp r0, 0
    je vfs_unlink_ino_fail
    sub r0, 1
    mov r2, r0
    mov r4, 0
    stw [r4+0x00A8], r2     ; 新链接数（vfs_set_links 会破坏 r2，不能靠寄存器带出来）
    ldw r1, [r4+0x00A2]
    call vfs_set_links
    cmp r0, 0
    jne vfs_unlink_ino_fail
    mov r4, 0
    ldw r3, [r4+0x00A2]
    ldw r2, [r4+0x00A8]
    cmp r2, 0
    jne vfs_unlink_ino_ok   ; 还有别的名字指着它
    mov r1, r3
    call vfs_free_ino
    ret
vfs_unlink_ino_ok:
    mov r0, 0
    ret
vfs_unlink_ino_fail:
    mov r0, 65535
    ret
; path_load: r1 = base，r2 = offset → r0 = 路径字节。
; 0x0048 为 0 表示用户指针（uldb，走 MMU），1 表示内核指针。保留 r1/r2/r3/r5/r6/r7。
path_load:
    push r4
    push r1
    add r1, r2
    mov r4, 0
    ldb r4, [r4+0x0048]
    cmp r4, 0
    jne path_load_k
    uldb r0, [r1+0]
    pop r1
    pop r4
    ret
path_load_k:
    ldb r0, [r1+0]
    pop r1
    pop r4
    ret

; vfs_resolve: r1 = 用户态路径（0 = 当前目录）→ r0 = inode 或 0xffff，
; 结果所在设备留在 v_dev / 0x00A2。沿途每一级目录都要搜索权。
vfs_resolve:
    mov r4, 0
    stw [r4+0x00A0], r1
    cmp r1, 0
    je vfs_resolve_cwd
    mov r2, 0
    call path_load
    mov r5, r0
    cmp r5, 47
    je vfs_resolve_root
vfs_resolve_cwd:
    call current_pcb
    mov r4, 0
    ldb r1, [r5+22]         ; cwd 设备
    ldb r6, [r5+23]         ; cwd inode
    push r6
    call vfs_setdev
    pop r6
    mov r1, r6
    call ino_in_range
    cmp r0, 0
    jne vfs_resolve_fail
    jmp vfs_resolve_start
vfs_resolve_root:
    mov r1, 1
    call vfs_setdev
    mov r6, ${ROOT_INO}
vfs_resolve_start:
    mov r4, 0
    stw [r4+0x00A2], r6
    ldw r1, [r4+0x00A0]
    cmp r1, 0
    je vfs_resolve_done
vfs_resolve_loop:
    mov r4, 0
    ldw r1, [r4+0x00A0]
vfs_resolve_skip:
    mov r2, 0
    call path_load
    mov r5, r0
    cmp r5, 47
    jne vfs_resolve_comp
    add r1, 1
    jmp vfs_resolve_skip
vfs_resolve_comp:
    stw [r4+0x00A0], r1
    cmp r5, 0
    je vfs_resolve_done
    cmp r5, 46              ; “.” / “..” 特别处理
    jne vfs_resolve_name
    mov r2, 1
    call path_load
    mov r5, r0
    cmp r5, 0
    je vfs_resolve_dot
    cmp r5, 47
    je vfs_resolve_dot
    cmp r5, 46
    jne vfs_resolve_name
    mov r2, 2
    call path_load
    mov r5, r0
    cmp r5, 0
    je vfs_resolve_up
    cmp r5, 47
    je vfs_resolve_up
vfs_resolve_name:
    mov r4, 0
    ldw r1, [r4+0x00A2]
    call ino_in_range
    cmp r0, 0
    jne vfs_resolve_fail
    call vfs_type           ; 只有目录能有下一级
    cmp r0, 2
    jne vfs_resolve_fail
    mov r4, 0
    ldw r1, [r4+0x00A2]
    mov r2, ${M_EXEC}       ; 属主搜索权
    mov r3, ${M_OEXEC}      ; 其他人搜索权
    call vfs_may
    cmp r0, 0
    jne vfs_resolve_fail
    mov r4, 0
    ldw r1, [r4+0x00A2]
    ldw r2, [r4+0x00A0]
    call vfs_lookup
    cmp r0, 65535
    je vfs_resolve_fail
    mov r4, 0
    stw [r4+0x00A2], r0
    call vfs_cross_down
    jmp vfs_resolve_next
vfs_resolve_dot:
    mov r4, 0
    ldw r1, [r4+0x00A2]
    mov r2, ${M_EXEC}
    mov r3, ${M_OEXEC}
    call vfs_may
    cmp r0, 0
    jne vfs_resolve_fail
    jmp vfs_resolve_next
vfs_resolve_up:
    mov r4, 0
    ldw r1, [r4+0x00A2]
    mov r2, ${M_EXEC}
    mov r3, ${M_OEXEC}
    call vfs_may
    cmp r0, 0
    jne vfs_resolve_fail
    call vfs_cross_up
vfs_resolve_next:
    mov r4, 0
    ldw r1, [r4+0x00A0]
vfs_resolve_adv:
    mov r2, 0
    call path_load
    mov r5, r0
    cmp r5, 0
    je vfs_resolve_adv_done
    cmp r5, 47
    je vfs_resolve_adv_done
    add r1, 1
    jmp vfs_resolve_adv
vfs_resolve_adv_done:
    stw [r4+0x00A0], r1
    jmp vfs_resolve_loop
vfs_resolve_done:
    mov r4, 0
    ldw r0, [r4+0x00A2]
    ret
vfs_resolve_fail:
    mov r0, 65535
    ret

; getdents(path, buf, max): 每项 16 字节，15 字节 NUL 补齐的名字 + 1 字节类型。
; 类型字节低两位 1 文件 2 目录 3 设备，bit2 是属主执行位。需要目录的读权限。
sys_getdents:
    mov r4, 0
    stw [r4+0x0086], r2 ; 用户游标
    stw [r4+0x0088], r3 ; 最多输出几条
    call vfs_resolve
    cmp r0, 65535
    je getdents_failed
    mov r4, 0
    stw [r4+0x0084], r0 ; 目录 inode
    mov r1, r0
    call vfs_type
    cmp r0, 2
    jne getdents_failed
    mov r4, 0
    ldw r1, [r4+0x0084]
    mov r2, ${M_READ}
    mov r3, ${M_OREAD}
    call vfs_may
    cmp r0, 0
    jne getdents_failed
    mov r4, 0
    ldw r1, [r4+0x0084]
    call vfs_size
    cmp r0, 65535
    je getdents_failed
    mov r4, 0
    stw [r4+0x008C], r0 ; 目录字节数
    stw [r4+0x008A], r4 ; 遍历偏移
    stw [r4+0x008E], r4 ; 已输出条数
getdents_next:
    mov r4, 0
    ldw r5, [r4+0x008E]
    ldw r6, [r4+0x0088]
    cmp r5, r6
    je getdents_done
    ldw r3, [r4+0x008A]
    ldw r5, [r4+0x008C]
    cmp r3, r5
    jgt getdents_done
    je getdents_done
    ldw r1, [r4+0x0084]
    mov r2, r3              ; vfs_dirent 的偏移参数在 r2
    call vfs_dirent          ; r0 = 子 inode，r5 = 名字，r6 = 长度，r7 = 下一条
    cmp r0, 65535
    je getdents_failed
    cmp r7, 0
    je getdents_done
    mov r4, 0
    stw [r4+0x008A], r7     ; 游标前进
    cmp r0, 0
    je getdents_next        ; 空槽
    stw [r4+0x0092], r0     ; 子 inode
    ldw r2, [r4+0x0086]
    mov r7, 0
getdents_name:
    cmp r7, 14
    je getdents_name_pad
    cmp r7, r6
    je getdents_name_pad
    ldb r1, [r5+0]
    ustb [r2+0], r1
    add r5, 1
    add r2, 1
    add r7, 1
    jmp getdents_name
getdents_name_pad:
    cmp r7, 15
    je getdents_name_end
    mov r1, 0
    ustb [r2+0], r1
    add r2, 1
    add r7, 1
    jmp getdents_name_pad
getdents_name_end:
    ; 类型字节：低两位 1 文件 / 2 目录 / 3 设备，bit2 = 属主可执行
    mov r4, 0
    stw [r4+0x0086], r2     ; 名字与补齐共 15 字节，类型跟在后面
    ldw r1, [r4+0x0092]
    call vfs_type
    cmp r0, 65535
    je getdents_failed
    mov r6, r0
    mov r4, 0
    ldw r1, [r4+0x0092]
    call vfs_perms
    cmp r0, 65535
    je getdents_failed
    and r0, ${M_EXEC}
    cmp r0, 0
    je getdents_type
    or r6, 4
getdents_type:
    mov r4, 0
    ldw r2, [r4+0x0086]
    ustb [r2+0], r6
    add r2, 1
    stw [r4+0x0086], r2
    ldw r5, [r4+0x008E]
    add r5, 1
    stw [r4+0x008E], r5
    jmp getdents_next
getdents_done:
    mov r4, 0
    ldw r0, [r4+0x008E]
    iret
getdents_failed:
    mov r0, 65535
    iret


; readview(kind, arg, buf)。第 8 类是 ls -l 的一行，其余类在 gp_view。
; 文件行只要沿途目录的搜索权。hexdump/objdump 另外要求读权限。
sys_view:
    mov r4, 0
    stw [r4+0x0094], r1
    stw [r4+0x0090], r2 ; 路径（用来取名字）
    stw [r4+0x0086], r3 ; 用户游标
    stw [r4+0x0088], r3 ; 用户缓冲区起点
    cmp r1, 8
    jne view_bridge
    mov r1, r2
    call vfs_resolve
    cmp r0, 65535
    je view_failed
    mov r4, 0
    stw [r4+0x0084], r0 ; inode
    mov r1, r0
    call vfs_type
    cmp r0, 65535
    je view_failed
    mov r4, 0
    stw [r4+0x0092], r0 ; 类型（目录末尾要加斜杠）
    mov r0, 45          ; '-'
    cmp r0, r0
    ldw r5, [r4+0x0092]
    cmp r5, 2
    jne view_type_dev
    mov r0, 100         ; d
view_type_dev:
    cmp r5, 3
    jne view_type_put
    mov r0, 99          ; c
view_type_put:
    call view_putc
    mov r4, 0
    ldw r1, [r4+0x0084]
    call vfs_perms
    cmp r0, 65535
    je view_failed
    mov r6, r0          ; view_bit 用 r6 当权限位
    mov r1, ${M_READ}
    mov r2, 114         ; 属主 r
    call view_bit
    mov r1, ${M_WRITE}
    mov r2, 119         ; 属主 w
    call view_bit
    mov r1, ${M_EXEC}
    mov r2, 120         ; 属主 x
    call view_bit
    mov r1, ${M_OREAD}
    mov r2, 114         ; 其他人 r
    call view_bit
    mov r1, ${M_OWRITE}
    mov r2, 119         ; 其他人 w
    call view_bit
    mov r1, ${M_OEXEC}
    mov r2, 120         ; 其他人 x
    call view_bit
    mov r1, ${M_SETUID}
    mov r2, 115         ; setuid
    call view_bit
    mov r1, ${M_STICKY}
    mov r2, 116         ; sticky
    call view_bit
    mov r0, 32
    call view_putc
    mov r0, 32
    call view_putc

    ; 属主：i_uid，root 打名字
    mov r4, 0
    ldw r1, [r4+0x0084]
    call vfs_uid
    cmp r0, ${UID_ROOT}
    je view_root
    mov r1, r0
    mov r2, 5
    mov r3, 1           ; 左对齐
    call view_num
    jmp view_owner_done
view_root:
    mov r0, ${UID_ROOT_NAME.charCodeAt(0)}
    call view_putc
    mov r0, ${UID_ROOT_NAME.charCodeAt(1)}
    call view_putc
    mov r0, ${UID_ROOT_NAME.charCodeAt(2)}
    call view_putc
    mov r0, ${UID_ROOT_NAME.charCodeAt(3)}
    call view_putc
    mov r0, 32
    call view_putc
view_owner_done:
    mov r0, 32
    call view_putc
    mov r0, 32
    call view_putc

    ; 大小
    mov r4, 0
    ldw r1, [r4+0x0084]
    call vfs_size
    mov r1, r0
    mov r2, 5
    mov r3, 0           ; 右对齐
    call view_num
    mov r0, 32
    call view_putc
    mov r0, 32
    call view_putc

    ; 名字：取路径的最后一段；没有就给空（根目录打 “/”）
    mov r4, 0
    ldw r1, [r4+0x0090]
    cmp r1, 0
    je view_slash
    call gp_last_slash
    cmp r0, 0
    je view_name_whole
    add r0, 1
    jmp view_name_start
view_name_whole:
    mov r4, 0
    ldw r0, [r4+0x0090]
view_name_start:
    mov r4, 0
    stw [r4+0x009E], r0
    mov r1, r0
    mov r2, 0
    call path_load
    cmp r0, 0
    je view_slash           ; 路径以 “/” 结尾（例如 “/”）
view_name_put:
    mov r4, 0
    ldw r1, [r4+0x009E]
    mov r2, 0
    call path_load
    cmp r0, 0
    je view_slash
    cmp r0, 47
    je view_slash
    call view_putc
    mov r4, 0
    ldw r1, [r4+0x009E]
    add r1, 1
    stw [r4+0x009E], r1
    jmp view_name_put
view_slash:
    mov r4, 0
    ldw r6, [r4+0x0092]
    cmp r6, 2
    jne view_end
    mov r0, 47
    call view_putc
view_end:
    mov r0, 10
    call view_putc
    mov r4, 0
    ldw r3, [r4+0x0086]
    mov r0, 0
    ustb [r3+0], r0     ; 行尾补 NUL，不计入长度
    ldw r0, [r4+0x0088]
    sub r3, r0
    mov r0, r3
    iret
view_failed:
    mov r0, 65535
    iret
view_bridge:
    jmp gp_view


; view_putc: r0 = 字节，写到用户缓冲区游标处。只破坏 r3 r4 (出口 r4 = 0)。
view_putc:
    mov r4, 0
    ldw r3, [r4+0x0086]
    ustb [r3+0], r0
    add r3, 1
    stw [r4+0x0086], r3
    ret

; view_bit: r6 = flags，r1 = 掩码，r2 = 置位时的字符，否则 '-'
view_bit:
    mov r0, r6
    and r0, r1
    cmp r0, 0
    je view_bit_dash
    mov r0, r2
    jmp view_putc
view_bit_dash:
    mov r0, 45
    jmp view_putc

; view_num: r1 = 值，r2 = 宽度，r3 = 0 右对齐 / 1 左对齐
view_num:
    mov r4, 0
    stw [r4+0x009C], r3
    mov r7, gp_digits
    mov r6, 0
view_num_digit:
    mov r5, r1
    mod r5, 10
    add r5, 48
    stb [r7+0], r5
    add r7, 1
    add r6, 1
    div r1, 10
    cmp r1, 0
    jne view_num_digit
    sub r2, r6
    mov r4, 0
    ldw r3, [r4+0x009C]
    cmp r3, 0
    jne view_num_out
    call view_pad
view_num_out:
    cmp r6, 0
    je view_num_tail
    sub r7, 1
    ldb r0, [r7+0]
    call view_putc
    sub r6, 1
    jmp view_num_out
view_num_tail:
    mov r4, 0
    ldw r3, [r4+0x009C]
    cmp r3, 0
    je view_num_done
    call view_pad
view_num_done:
    ret

; view_pad: 输出 r2 个空格
view_pad:
    cmp r2, 0
    je view_pad_done
    mov r0, 32
    call view_putc
    sub r2, 1
    jmp view_pad
view_pad_done:
    ret

; yield: 让出当前时间片，触发轮转调度
sys_yield:
    mov r4, 0
    mov r5, 5           ; k_quantum
    stw [r4+0x002E], r5 ; k_time_slice = quantum (触发调度)
    call do_schedule
    cmp r0, 0
    je yield_same       ; 没有切换时先 iret，不要悬停在 kernel mode
    sched               ; 切到 KCB 指定的 CPU 上下文
yield_same:
    sched               ; 没有别的进程可跑：把 CPU 交还宿主，而不是把时间片烧在 sys/iret 循环里
    mov r0, 0
    iret

; getpid: 从当前进程 PCB 读取 PID 返回
sys_getpid:
    mov r4, 0
    ldw r5, [r4+0x0022] ; r5 = k_current_slot
    mul r5, 192
    add r5, 0x0100      ; r5 = PCB 物理基址
    ldw r0, [r5+2]      ; r0 = PCB.pid
    iret

; getuid: r0 = 真实 uid，r1 = 有效 uid。账户工具据此区分普通用户与管理行为。
sys_getuid:
    call current_pcb
    ldw r0, [r5+${PCB_UID}]
    ldw r1, [r5+${PCB_EUID}]
    iret

; ttyecho: r1 = 0 关闭 canonical tty 回显，其余值恢复。宿主 MMIO 0xFF12。
sys_ttyecho:
    mov r4, 0xFF12
    stb [r4+0], r1
    mov r0, 0
    iret

sys_password:
    call current_euid
    cmp r0, ${UID_ROOT}
    jne password_denied
    mov r0, 46
    svc
    iret
password_denied:
    mov r0, 65535
    iret

; gethz: 从 KCB (0x0024) 读取时钟中断频率
sys_gethz:
    mov r4, 0
    ldw r0, [r4+0x0024] ; r0 = k_hz
    iret

; tcsetpgrp: 设置前台进程组 PID。不能指向 idle/init，非 root 只能指向自己有权发信号的进程。
sys_tcsetpgrp:
    cmp r1, 1
    jlt tcset_failed
    je tcset_failed
    push r1
    call gp_may_signal
    pop r1
    cmp r0, 0
    jne tcset_failed
    mov r4, 0
    stw [r4+0x002C], r1 ; k_fg_pid = r1
    mov r0, 0
    iret
tcset_failed:
    mov r0, 65535
    iret

; clock_gettime: 返回低位 ticks
sys_time:
    mov r4, 0
    ldw r0, [r4+0x0028] ; r0 = k_ticks_lo
    iret

; chmod(path, set, clear): (flags | set) & ~clear & 255。
; 非 root 不能把 setuid 位置上。inode 必须先通过范围检查，再做 48 倍乘法。
sys_chmod:
    jmp gp_chmod

; chdir(path): resolve an sda directory and store cwd device/inode in PCB.
sys_chdir:
    jmp gp_chdir

; sleep(ticks): 将当前 PCB 标记为 BLOCKED，记录 32 位 tick 截止值，然后调度
; wake deadline 存在 PCB 155..162 的低 32 位 (159..162)
sys_sleep:
    cmp r1, 0
    je sleep_done
    mov r4, 0
    ldw r5, [r4+0x0028] ; current tick low
    ldw r6, [r4+0x002A] ; current tick high
    mov r7, r5          ; old low for carry detection
    add r5, r1
    cmp r5, r7
    jlt sleep_carry
    jmp sleep_store
sleep_carry:
    add r6, 1
sleep_store:
    push r5             ; deadline low
    push r6             ; deadline high
    call current_pcb
    pop r6              ; deadline high
    pop r7              ; deadline low
    mov r4, 4           ; BLOCKED
    stb [r5+1], r4
    mov r4, 1
    stb [r5+163], r4    ; sleeping
    mov r4, 0
    stw [r5+155], r4
    stw [r5+157], r4
    stw [r5+159], r6
    stw [r5+161], r7
    call do_schedule
    sched
sleep_done:
    mov r0, 0
    iret

; sync: 请求块控制器刷新所有可写设备到宿主持久化后端
sys_sync:
    mov r4, 0xFE00
    mov r5, 0
    stw [r4+2], r5      ; device 0 = all devices
    mov r5, 3           ; command 3 = FLUSH
    stw [r4+0], r5
    ldw r0, [r4+8]
    cmp r0, 1
    jne sync_failed
    mov r0, 0
    iret
sync_failed:
    mov r0, 65535
    iret

; close(fd): 清空当前 PCB 中的 6 字节 fd 槽
sys_close:
    cmp r1, 7
    jgt fd_failed
    call current_pcb
    mov r6, r1
    mul r6, 6
    add r5, 41
    add r5, r6          ; r5 = fd slot
    ldb r7, [r5+0]
    cmp r7, 0
    je fd_failed
    mov r7, 0
    mov r6, 0
close_zero:
    cmp r6, 6
    je close_count
    stb [r5+0], r7
    add r5, 1
    add r6, 1
    jmp close_zero
close_count:
    call current_pcb
    ldb r6, [r5+40]
    cmp r6, 0
    je close_done
    sub r6, 1
    stb [r5+40], r6
close_done:
    mov r0, 0
    iret

; dup(fd): 找到 3..7 中的空闲槽并复制 6 字节 fd 记录
sys_dup:
    cmp r1, 7
    jgt fd_failed
    call current_pcb
    mov r6, r1
    mul r6, 6
    add r5, 41
    add r5, r6          ; r5 = source slot
    ldb r7, [r5+0]
    cmp r7, 0
    je fd_failed
    mov r4, 3           ; candidate fd
dup_find:
    cmp r4, 8
    je fd_failed
    call current_pcb
    mov r6, r4
    mul r6, 6
    add r5, 41
    add r5, r6          ; candidate slot
    ldb r7, [r5+0]
    cmp r7, 0
    je dup_found
    add r4, 1
    jmp dup_find
dup_found:
    mov r2, r4          ; target fd for common copy routine
    call copy_fd
    mov r0, r2
    iret

; dup2(old,new): 覆盖目标槽，返回 new
sys_dup2:
    cmp r1, 7
    jgt fd_failed
    cmp r2, 7
    jgt fd_failed
    call current_pcb
    mov r6, r1
    mul r6, 6
    add r5, 41
    add r5, r6
    ldb r7, [r5+0]
    cmp r7, 0
    je fd_failed
    call copy_fd
    mov r0, r2
    iret

; copy_fd: r1=source fd, r2=target fd
copy_fd:
    call current_pcb
    mov r6, r1
    mul r6, 6
    add r5, 41
    add r5, r6          ; source
    mov r4, r5
    call current_pcb
    mov r6, r2
    mul r6, 6
    add r5, 41
    add r5, r6          ; target
    ldb r7, [r5+0]
    cmp r7, 0
    jne copy_fd_bytes
    call current_pcb
    ldb r7, [r5+40]
    add r7, 1
    stb [r5+40], r7
    ; restore target pointer
    mov r6, r2
    mul r6, 6
    add r5, 41
    add r5, r6
copy_fd_bytes:
    mov r6, 0
copy_fd_loop:
    cmp r6, 6
    je copy_fd_done
    ldb r7, [r4+0]
    stb [r5+0], r7
    add r4, 1
    add r5, 1
    add r6, 1
    jmp copy_fd_loop
copy_fd_done:
    ret

; may_write_ino / may_signal_pid / current_euid 已归入 guestpolicy.ts。

; 信号判定在 guestpolicy.ts 的 gp_may_signal。

; current_pcb: returns current PCB physical address in r5
current_pcb:
    mov r5, 0
    ldw r5, [r5+0x0022]
    mul r5, 192
    add r5, 0x0100
    ret

fd_failed:
    mov r0, 65535
    iret

; r5 = PTE, r3 = vpn, r4 = pfn, r6 = PCB。低 6 位进页表字节，bit6/bit7 进掩码。
pte_store:
    mov r7, r4
    and r7, 63
    or r7, 128
    stb [r5+0], r7
    mov r7, 1
    shl r7, r3
    ldw r0, [r6+184]
    mov r2, r4
    shr r2, 6
    and r2, 1
    cmp r2, 0
    je pte_clr6
    or r0, r7
    jmp pte_bit7
pte_clr6:
    mov r2, r7
    xor r2, 65535
    and r0, r2
pte_bit7:
    stw [r6+184], r0
    ldw r0, [r6+186]
    mov r2, r4
    shr r2, 7
    and r2, 1
    cmp r2, 0
    je pte_clr7
    or r0, r7
    jmp pte_stored
pte_clr7:
    mov r2, r7
    xor r2, 65535
    and r0, r2
pte_stored:
    stw [r6+186], r0
    ret

; r6 = PTE, r5 = PCB, r3 = vpn。完整帧号返回在 r4。
pte_load:
    ldb r4, [r6+0]
    and r4, 63
    mov r7, 1
    shl r7, r3
    ldw r0, [r5+184]
    and r0, r7
    cmp r0, 0
    je pte_load7
    add r4, 64
pte_load7:
    ldw r0, [r5+186]
    and r0, r7
    cmp r0, 0
    je pte_loaded
    add r4, 128
pte_loaded:
    ret

; page_alloc(vpn): 扫描物理帧位图，为当前进程映射一个清零的新页面
sys_page_alloc:
    mov r3, r1          ; 保存目标 VPN
    cmp r3, 10          ; VPN 11..15 属于 supervisor 映射
    jgt page_failed

    ; 检查目标 PTE 必须为空
    mov r4, 0
    ldw r5, [r4+0x0022]
    mul r5, 192
    add r5, 0x0100      ; current PCB
    mov r6, r5
    add r6, 24
    add r6, r3          ; &pcb.page_table[vpn]
    ldb r7, [r6+0]
    cmp r7, 0
    jne page_failed

    ; 从 KCB 指定的首个用户帧开始扫描物理帧位图，到内核文本帧为止
    mov r4, 0
    ldw r4, [r4+0x003E] ; pfn = k_first_user_pfn
page_scan:
    mov r0, 0
    ldw r0, [r0+0x001E] ; k_text_pfn
    cmp r4, r0
    je page_failed
    mov r5, r4
    div r5, 8           ; bitmap byte index
    mov r6, r4
    mod r6, 8           ; bitmap bit index
    mov r7, 1
    shl r7, r6          ; mask
    add r5, 0x00E0      ; bitmap address
    ldb r2, [r5+0]
    mov r0, r2
    and r0, r7
    cmp r0, 0
    je page_found
    add r4, 1
    jmp page_scan

page_found:
    ; 标记物理帧已用
    or r2, r7
    stb [r5+0], r2

    ; 写入当前 PCB 的页表项: VALID(0x80) | PFN[5:0]，高两位在 PCB+184/186
    mov r5, 0
    ldw r6, [r5+0x0022]
    mul r6, 192
    add r6, 0x0100      ; PCB
    mov r5, r6
    add r5, 24
    add r5, r3          ; PTE address
    call pte_store
    ldb r7, [r6+21]     ; npages++
    add r7, 1
    stb [r6+21], r7

    ; 清零物理页面
    mov r5, r4
    mul r5, 256         ; physical page base
    mov r6, 0
    mov r7, 0
page_zero:
    cmp r6, 256
    je page_alloc_done
    stb [r5+0], r7
    add r5, 1
    add r6, 1
    jmp page_zero

page_alloc_done:
    mov r0, r3
    mul r0, 256         ; 返回映射的虚拟地址
    iret

page_failed:
    mov r0, 65535
    iret

; page_free(vpn): 解除当前进程页表映射并归还物理帧
sys_page_free:
    mov r3, r1
    cmp r3, 10
    jgt page_free_failed
    mov r4, 0
    ldw r5, [r4+0x0022]
    mul r5, 192
    add r5, 0x0100      ; current PCB
    mov r6, r5
    add r6, 24
    add r6, r3          ; PTE address
    ldb r4, [r6+0]
    cmp r4, 0
    je page_free_failed
    call pte_load
    mov r7, 0
    ldw r7, [r7+0x003E]
    cmp r4, r7
    jlt page_free_failed
    mov r7, 0
    ldw r7, [r7+0x001E] ; 不能把内核文本帧还回用户池
    cmp r4, r7
    jgt page_free_failed
    je page_free_failed

    mov r7, 0
    stb [r6+0], r7      ; clear PTE
    mov r7, 1
    shl r7, r3
    xor r7, 65535
    ldw r0, [r5+184]
    and r0, r7
    stw [r5+184], r0
    ldw r0, [r5+186]
    and r0, r7
    stw [r5+186], r0
    ldb r7, [r5+21]
    cmp r7, 0
    je page_free_bitmap
    sub r7, 1
    stb [r5+21], r7

page_free_bitmap:
    mov r5, r4
    div r5, 8
    mov r6, r4
    mod r6, 8
    mov r7, 1
    shl r7, r6
    xor r7, 65535       ; inverse mask
    add r5, 0x00E0
    ldb r0, [r5+0]
    and r0, r7
    stb [r5+0], r0
    mov r0, 0
    iret

page_free_failed:
    mov r0, 65535
    iret

; 原始块设备驱动：通过 MMIO 控制器搬运一个完整块
;   0xFE00 cmd (1=read, 2=write), 0xFE02 device, 0xFE04 block,
;   0xFE06 buffer virtual address, 0xFE08 status
sys_block_read:
    push r1
    mov r1, 98
    call gp_perm_ok
    pop r1
    cmp r0, 0
    jne block_failed
    mov r4, 0xFE00
    stw [r4+2], r1
    stw [r4+4], r2
    stw [r4+6], r3
    mov r5, 1
    stw [r4+0], r5
    ldw r0, [r4+8]
    cmp r0, 1
    jne block_failed
    mov r0, 0
    iret

sys_block_write:
    push r1
    mov r1, 98
    call gp_perm_ok
    pop r1
    cmp r0, 0
    jne block_failed
    mov r4, 0xFE00
    stw [r4+2], r1
    stw [r4+4], r2
    stw [r4+6], r3
    mov r5, 2
    stw [r4+0], r5
    ldw r0, [r4+8]
    cmp r0, 1
    jne block_failed
    mov r0, 0
    iret

block_failed:
    mov r0, 65535
    iret

; kill: 遍历 16 个 PCB 槽位，匹配 target_pid 并置状态为 ZOMBIE (5)
sys_kill:
    cmp r1, 0
    je kill_failed
    cmp r1, 1
    je kill_init_gate
    push r1
    push r2
    call gp_may_signal
    pop r2
    pop r1
    cmp r0, 0
    jne kill_failed
    jmp kill_scan
kill_init_gate:
    push r1
    call current_euid
    pop r1
    cmp r0, 0
    jne kill_failed
    mov r0, 22
    jmp kill_init
kill_scan:
    mov r4, 0           ; r4 = slot (0..31)
kill_loop:
    cmp r4, 16
    je kill_notfound
    mov r5, r4
    mul r5, 192
    add r5, 0x0100      ; r5 = PCB[slot]
    ldb r6, [r5+0]      ; inuse
    cmp r6, 1
    jne kill_next
    ldw r6, [r5+2]      ; pid
    cmp r6, r1
    je kill_target
kill_next:
    add r4, 1
    jmp kill_loop

kill_target:
    jmp kill_apply
kill_apply:
    mov r6, 5           ; PState.ZOMBIE
    stb [r5+1], r6      ; PCB.state = ZOMBIE
    mov r6, 128
    add r6, r2          ; 128 + sig
    stw [r5+12], r6     ; PCB.exitCode = 128 + sig
    mov r0, 22          ; 兼容桥只负责释放目标资源与唤醒 waitpid
    svc
    iret

kill_init:
    svc                 ; 杀 init 触发 kernel panic
    iret

kill_notfound:
kill_failed:
    mov r0, 65535       ; -1 ESRCH
    iret

; exit: 标记当前 PCB 为 ZOMBIE 并记录退出码
sys_exit:
    mov r4, 0
    ldw r5, [r4+0x0022] ; current slot
    mul r5, 192
    add r5, 0x0100      ; PCB
    mov r6, 5           ; ZOMBIE
    stb [r5+1], r6      ; state = ZOMBIE
    stw [r5+12], r1     ; exit code = r1
    call gp_exit_book
    mov r0, 3
    svc                 ; 宿主只释放生成器和物理页
    iret

; 中断向量 1：时钟中断入口 (硬件定时器 IRQ 触发进入此处)
timer_entry:
    cli
    ; 1. 递增全局 ticks (0x0028/0x002A)
    mov r4, 0
    ldw r5, [r4+0x0028] ; tick_lo
    add r5, 1
    stw [r4+0x0028], r5
    cmp r5, 0
    jne timer_pcb
    ldw r6, [r4+0x002A] ; tick_hi
    add r6, 1
    stw [r4+0x002A], r6

timer_pcb:
    ; 2. 累加当前进程占用时间片
    ldw r5, [r4+0x0022] ; current slot
    mul r5, 192
    add r5, 0x0100      ; PCB
    ; PCB.cpu_ticks 是 offset 147 的 64 位大端计数，低 16 位在 +153
    ldw r6, [r5+153]
    add r6, 1
    stw [r5+153], r6
    cmp r6, 0
    jne timer_wake
    ldw r6, [r5+151]
    add r6, 1
    stw [r5+151], r6
    cmp r6, 0
    jne timer_wake
    ldw r6, [r5+149]
    add r6, 1
    stw [r5+149], r6
    cmp r6, 0
    jne timer_wake
    ldw r6, [r5+147]
    add r6, 1
    stw [r5+147], r6

timer_wake:
    ; 3. 扫描 BLOCKED+sleeping PCB，根据 32 位 tick deadline 唤醒
    mov r0, 0
    ldw r1, [r0+0x0028] ; current low
    ldw r2, [r0+0x002A] ; current high
    mov r3, 0
wake_scan:
    cmp r3, 16
    je wake_done
    mov r4, r3
    mul r4, 192
    add r4, 0x0100
    ldb r5, [r4+0]
    cmp r5, 1
    jne wake_next
    ldb r5, [r4+1]
    cmp r5, 4           ; BLOCKED
    jne wake_next
    ldb r5, [r4+163]
    cmp r5, 1
    jne wake_next
    ldw r5, [r4+159]    ; deadline high
    cmp r2, r5
    jgt wake_proc
    jlt wake_next
    ldw r5, [r4+161]    ; deadline low
    cmp r1, r5
    jlt wake_next
wake_proc:
    mov r5, 0
    stb [r4+163], r5    ; sleeping = false
    mov r5, 2
    stb [r4+1], r5      ; state = READY
wake_next:
    add r3, 1
    jmp wake_scan

wake_done:
    ; 4. 检查时间片与轮转调度
    mov r4, 0
    ldw r6, [r4+0x002E] ; k_time_slice
    add r6, 1
    stw [r4+0x002E], r6
    ldw r7, [r4+0x003C] ; k_quantum (5)
    cmp r6, r7
    jlt timer_done
    call do_schedule
    cmp r0, 0
    je timer_done
    sched               ; 机器码调度器完成上下文边界

timer_done:
    iret

; do_schedule: 机器码轮转调度器 (Round-Robin Scheduler)
; 扫描 16 个 PCB 槽位，寻找下一个处于 READY (2) 状态的进程进行切换
do_schedule:
    mov r0, 0
    stw [r0+0x002E], r0 ; 重置 k_time_slice = 0
    ldw r1, [r0+0x0022] ; r1 = current_slot
    mov r2, r1          ; r2 = scan pointer
    mov r3, 0           ; r3 = count of checked slots
sched_scan:
    add r2, 1
    cmp r2, 16
    jlt sched_check
    mov r2, 0           ; 回绕到 slot 0
sched_check:
    add r3, 1
    cmp r3, 17
    jgt sched_none      ; 遍历一整圈未找到

    ; 检查 PCB[r2]
    mov r4, r2
    mul r4, 192
    add r4, 0x0100      ; r4 = PCB[r2]
    ldb r5, [r4+0]      ; inuse
    cmp r5, 1
    jne sched_scan
    ldb r5, [r4+1]      ; state
    cmp r5, 2           ; PState.READY == 2
    jne sched_scan

    ; 找到目标就绪进程 r2！执行上下文切换
    cmp r2, r1
    je sched_same       ; 目标即是当前进程

    ; 若当前进程是 RUNNING (3)，将其置为 READY (2)
    mov r4, r1
    mul r4, 192
    add r4, 0x0100      ; PCB[current]
    ldb r5, [r4+1]
    cmp r5, 3           ; RUNNING
    jne sched_set_next
    mov r5, 2           ; READY
    stb [r4+1], r5

sched_set_next:
    ; 设置目标进程为 RUNNING (3)
    mov r4, r2
    mul r4, 192
    add r4, 0x0100      ; PCB[next]
    mov r5, 3           ; RUNNING
    stb [r4+1], r5
    ldw r6, [r4+2]      ; next.pid

    ; 更新 KCB
    mov r0, 0
    stw [r0+0x0020], r6 ; k_current_pid = next.pid
    stw [r0+0x0022], r2 ; k_current_slot = next_slot
    ldw r5, [r0+0x0026] ; k_switches
    add r5, 1
    stw [r0+0x0026], r5 ; k_switches++
    mov r0, 1           ; 告知调用者发生了切换
    ret

sched_same:
sched_none:
    mov r0, 0
    ret

; 中断向量 2：缺页 / 权限故障处理
fault_entry:
    cli
    svc
    iret

; 中断向量 3：TTY 输入 IRQ。唤醒第一个阻塞在 stdin 的进程并调度它。
tty_entry:
    cli
    mov r3, 0
tty_scan:
    cmp r3, 16
    je tty_done
    mov r4, r3
    mul r4, 192
    add r4, 0x0100
    ldb r5, [r4+0]
    cmp r5, 1
    jne tty_next
    ldb r5, [r4+1]
    cmp r5, 4
    jne tty_next
    ldb r5, [r4+20]
    cmp r5, 1
    jne tty_next
    mov r5, 2
    stb [r4+1], r5      ; READY
    mov r5, 0
    stb [r4+20], r5
    call do_schedule
    cmp r0, 0
    je tty_done
    sched
tty_next:
    add r3, 1
    jmp tty_scan
tty_done:
    iret

.data
ivt:
    .word syscall_entry
    .word timer_entry
    .word fault_entry
    .word tty_entry
`

// pid 0。没有用户进程可运行时 CPU 执行这个 CRX 循环，硬件 timer IRQ 仍会
// 正常进入 guest kernel，从而唤醒睡眠进程。
export const GUEST_IDLE_SOURCE = `.text
_start:
idle:
    mov r0, 0
    sys
    jmp idle
`
