// CRX 机器码内核 (Guest OS Kernel in CRX Machine Code)
//
// 运行在 supervisor 特权模式下。
// 内存布局 (Physical Memory Layout):
//   0x0000..0x003F : Kernel Control Block (KCB)
//     0x0000..0x001D : 引导标语 "crados 3.2\n"
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
//   0x0040 : v_dev (u16)，只读 VFS 当前设备号
//   0x0042 : v_mult (u16)，该设备每块的 256 B 扇区数
//   0x0050..0x00BF : 各系统调用的暂存字
//   0x00C0..0x00DF : 挂载表，8 项 x 4 字节 (宿主设备, 宿主 inode, 被挂设备, v_mult)
//   0x00E0..0x00FF : k_frame_bitmap (256 frames = 32 bytes)
//   0x0100..0x0CFF : Process Control Block Table (16 PCBs x 192 bytes)
//   0x0D00..0x0DFF : Kernel Device Scratch Page
//   0xA400..0xA7FF : host kmsg (u16 length, then text). Not a user page.
//   0xA800..0xA9FF : host device catalog, 8 x 64 B. CRX formats lsblk and df.
//   high frames    : CRX Kernel Text (KERNEL_TEXT_PAGES, physical direct map)
//   0xFF00..0xFFFF : MMIO，不是内存

import { SDA_INODES } from './blockdev'
import { M_EXEC, M_OEXEC, M_OREAD, M_READ, M_SETUID, SB_UID, UID_ROOT, UID_ROOT_NAME, UID_USER, UID_USER_NAME } from './fs'

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
    stw [r4+0x0046], r4 ; 块读写设备覆盖，0 表示 sda
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

    mov r0, 65535
    iret

; write(fd, buf, len): 从当前 PCB 的 fd 表读取目标类型。
; tty/stdout/stderr 通过虚拟硬件 MMIO 端口输出；重定向到文件时交由 CRFS 桥。
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
    cmp r6, 254         ; ROM is firmware, not a writable CRFS
    je write_file_failed
    mov r7, 0           ; r4 is the user buffer; do not clobber it
    stw [r7+0x0046], r6
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

; sda regular-file write: update CRFS bitmap, inode direct pointer, data block,
; inode size and PCB fd offset. One syscall writes at most to the end of the
; current 256-byte block; libc-style callers retry the remainder.
write_file:
    ldb r6, [r3+44]     ; flags: 0=read, 1=write, 2=append
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

    ; length 0 means NUL-terminated
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
    stw [r6+0x0060], r3 ; fd base
    stw [r6+0x0062], r4 ; user buffer
    stw [r6+0x0064], r5 ; requested length
    ldw r7, [r3+45]     ; current offset
    stw [r6+0x0066], r7
    ldb r5, [r3+43]     ; inode number
    mul r5, 48
    add r5, 768         ; inode global byte offset
    stw [r6+0x0068], r5

    mov r1, r5
    add r1, 2
    call crfs_u16       ; file size
    cmp r0, 65535
    je write_file_failed
    mov r6, 0
    stw [r6+0x006A], r0

    ; count = min(length, 256 - (pos mod 256))
    ldw r7, [r6+0x0066]
    mov r5, r7
    mod r5, 256
    stw [r6+0x006C], r5
    mov r4, 256
    sub r4, r5
    ldw r3, [r6+0x0064]
    cmp r3, r4
    jlt write_count_ok
    mov r3, r4
write_count_ok:
    stw [r6+0x006E], r3

    ; ptr_address = inode + 8 + (pos/256)*2
    mov r4, r7
    div r4, 256
    mul r4, 2
    ldw r1, [r6+0x0068]
    add r1, 8
    add r1, r4
    stw [r6+0x0070], r1
    call crfs_u16
    cmp r0, 65535
    je write_file_failed
    cmp r0, 0
    jne write_have_block

    ; Allocate a CRFS data block and install the new direct pointer
    call crfs_alloc_block
    cmp r0, 65535
    je write_file_failed
    mov r6, 0
    stw [r6+0x0072], r0
    ldw r1, [r6+0x0070]
    mov r2, r0
    call crfs_write_u16
    cmp r0, 0
    jne write_file_failed
    mov r6, 0
    ldw r0, [r6+0x0072]

write_have_block:
    mov r6, 0
    stw [r6+0x0072], r0 ; data block
    mov r1, r0
    call sda_read_block
    cmp r0, 0
    jne write_file_failed

    ; Copy user buffer into scratch block
    mov r6, 0
    ldw r2, [r6+0x0062]
    ldw r3, [r6+0x006E]
    ldw r4, [r6+0x006C]
    add r4, 0x0D00
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
    call sda_write_block
    cmp r0, 0
    jne write_file_failed

    ; Advance fd offset and grow inode size if necessary
    mov r6, 0
    ldw r3, [r6+0x006E] ; count
    ldw r4, [r6+0x0066] ; old pos
    add r4, r3          ; new pos
    ldw r5, [r6+0x0060]
    stw [r5+45], r4
    ldw r7, [r6+0x006A] ; old size
    cmp r4, r7
    jlt write_file_done
    je write_file_done
    ldw r1, [r6+0x0068]
    add r1, 2
    mov r2, r4
    call crfs_write_u16
    cmp r0, 0
    jne write_file_failed
write_file_done:
    mov r6, 0
    ldw r0, [r6+0x006E]
    iret
write_file_failed:
    mov r0, 65535
    iret

; read(fd, buf, max): sda 普通文件由机器码直接解析 CRFS inode 和块指针。
; TTY、ROM 和其他设备暂由兼容路径处理。
sys_read:
    cmp r1, 7
    jgt read_bridge
    ; 定位 fd record
    call current_pcb
    mov r4, r1
    mul r4, 6
    add r5, 41
    add r5, r4          ; r5 = fd record
    ldb r4, [r5+0]      ; kind
    cmp r4, 1           ; stdin
    je read_tty
    cmp r4, 4           ; /dev/tty
    je read_tty
    cmp r4, 5           ; /dev/null
    je read_eof
    cmp r4, 6           ; regular file
    jne read_bridge
    ldb r4, [r5+1]      ; device
    mov r6, 0
    stw [r6+0x0046], r4
    cmp r4, 254         ; ROM blocks are 1 KiB
    je gp_read_wide
    cmp r4, 1
    je read_native
    push r5
    mov r1, r4
    call vfs_setdev
    pop r5
    mov r6, 0
    ldw r4, [r6+0x0042]
    cmp r4, 1
    jne gp_read_wide
read_native:

    ; 保存 read 上下文到 KCB scratch 0x0050..
    mov r4, 0
    stw [r4+0x0050], r5 ; fd record
    stw [r4+0x0052], r2 ; user buffer
    stw [r4+0x0054], r3 ; max length
    ldw r6, [r5+4]      ; file offset
    stw [r4+0x0056], r6
    ldb r7, [r5+2]      ; inode

    ; inode_global = itable block 3 * 256 + ino * 48
    mul r7, 48
    add r7, 768
    stw [r4+0x005A], r7

    ; file size = inode + 2
    mov r1, r7
    add r1, 2
    call crfs_u16
    cmp r0, 65535
    je read_failed
    mov r4, 0
    stw [r4+0x0058], r0
    ldw r6, [r4+0x0056] ; pos
    cmp r6, r0
    jlt read_have_data
    jmp read_eof

read_have_data:
    ; count = min(max, size-pos, 256-(pos%256))
    mov r7, r0
    sub r7, r6          ; remaining file bytes
    ldw r3, [r4+0x0054]
    cmp r3, r7
    jlt read_max_ok
    mov r3, r7
read_max_ok:
    mov r2, r6
    mod r2, 256         ; data offset inside block
    mov r7, 256
    sub r7, r2
    cmp r3, r7
    jlt read_block_ok
    mov r3, r7
read_block_ok:
    stw [r4+0x005C], r3 ; count
    stw [r4+0x005E], r2 ; in-block offset

    ; direct pointer = inode + 8 + (pos/256)*2
    mov r2, r6
    div r2, 256
    mul r2, 2
    ldw r1, [r4+0x005A]
    add r1, 8
    add r1, r2
    call crfs_u16
    cmp r0, 0
    je read_failed
    cmp r0, 65535
    je read_failed

    mov r1, r0          ; disk data block
    call sda_read_block
    cmp r0, 0
    jne read_failed

    ; copy scratch+offset -> user buffer
    mov r4, 0
    ldw r2, [r4+0x0052]
    ldw r3, [r4+0x005C]
    ldw r6, [r4+0x005E]
    add r6, 0x0D00
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
    ldw r5, [r4+0x0050]
    ldw r6, [r4+0x0056]
    add r6, r3
    stw [r5+4], r6      ; fd.offset += count
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
    cmp r6, 1
    jne read_tty_done
    ldb r6, [r7+1]
    ustb [r4+0], r6
    add r4, 1
    add r0, 1
    jmp read_tty_loop
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

; crfs_u16: read a big-endian u16 at absolute byte offset r1 from sda
crfs_u16:
    cmp r1, 61440       ; 回绕后的高地址不是合法元数据偏移
    jlt crfs_u16_span
    jmp crfs_u16_fail
crfs_u16_span:
    mov r2, r1
    div r1, 256         ; block
    mod r2, 256         ; offset
    cmp r2, 255         ; 一个字不能跨出暂存页
    je crfs_u16_fail
    push r2
    call sda_read_block
    pop r2
    cmp r0, 0
    jne crfs_u16_fail
    mov r3, 0x0D00
    add r3, r2
    ldw r0, [r3+0]
    ret
crfs_u16_fail:
    mov r0, 65535
    ret

; crfs_u8: read one byte at absolute byte offset r1 from sda
crfs_u8:
    cmp r1, 61440
    jlt crfs_u8_body
    jmp crfs_u8_fail
crfs_u8_body:
    mov r2, r1
    div r1, 256
    mod r2, 256
    push r2
    call sda_read_block
    pop r2
    cmp r0, 0
    jne crfs_u8_fail
    mov r3, 0x0D00
    add r3, r2
    ldb r0, [r3+0]
    ret
crfs_u8_fail:
    mov r0, 65535
    ret

; crfs_write_u8: r1=absolute byte offset, r2=value.
crfs_write_u8:
    push r2
    cmp r1, 61440
    jlt crfs_write_u8_ok
    pop r2
    jmp crfs_write_u8_fail
crfs_write_u8_ok:
    mov r3, r1
    div r1, 256
    mod r3, 256
    push r3
    push r1
    call sda_read_block
    pop r1
    pop r3
    pop r2
    cmp r0, 0
    jne crfs_write_u8_fail
    mov r4, 0x0D00
    add r4, r3
    stb [r4+0], r2
    call sda_write_block
    ret
crfs_write_u8_fail:
    mov r0, 65535
    ret

; sda_read_block: r1=block, return 0 success or 0xffff
sda_read_block:
    mov r4, 0
    ldw r5, [r4+0x0046]
    cmp r5, 0
    jne sda_read_dev
    mov r5, 1
sda_read_dev:
    mov r4, 0xFE00
    stw [r4+2], r5
    stw [r4+4], r1
    mov r5, 0x0D00
    stw [r4+6], r5
    mov r5, 4           ; command 4 = READ to supervisor physical buffer
    stw [r4+0], r5
    ldw r0, [r4+8]
    cmp r0, 1
    jne sda_read_fail
    mov r0, 0
    ret
sda_read_fail:
    mov r0, 65535
    ret

; sda_write_block: r1=block, writes scratch 0x0D00, return 0/0xffff
sda_write_block:
    mov r4, 0
    ldw r5, [r4+0x0046]
    cmp r5, 0
    jne sda_write_dev
    mov r5, 1
sda_write_dev:
    mov r4, 0xFE00
    stw [r4+2], r5
    stw [r4+4], r1
    mov r5, 0x0D00
    stw [r4+6], r5
    mov r5, 5           ; command 5 = WRITE from supervisor physical buffer
    stw [r4+0], r5
    ldw r0, [r4+8]
    cmp r0, 1
    jne sda_write_fail
    mov r0, 0
    ret
sda_write_fail:
    mov r0, 65535
    ret

; crfs_write_u16: r1=absolute byte offset, r2=value
crfs_write_u16:
    push r2
    cmp r1, 61440
    jlt crfs_write_u16_span
    pop r2
    jmp crfs_write_u16_fail
crfs_write_u16_span:
    mov r3, r1
    div r1, 256
    mod r3, 256
    cmp r3, 255         ; 一个字不能跨出暂存页
    jne crfs_write_u16_ok
    pop r2
    jmp crfs_write_u16_fail
crfs_write_u16_ok:
    push r3
    push r1
    call sda_read_block
    pop r1
    pop r3
    pop r2
    cmp r0, 0
    jne crfs_write_u16_fail
    mov r4, 0x0D00
    add r4, r3
    stw [r4+0], r2
    call sda_write_block
    ret
crfs_write_u16_fail:
    mov r0, 65535
    ret

; crfs_alloc_block: allocate and zero one sda data block, return block number
crfs_alloc_block:
    mov r1, 1           ; block bitmap
    call sda_read_block
    cmp r0, 0
    jne crfs_alloc_fail
    mov r4, 15          ; CRFS dataStart for the current on-disk format
crfs_alloc_scan:
    cmp r4, 2048
    je crfs_alloc_fail
    mov r5, r4
    div r5, 8
    mov r6, r4
    mod r6, 8
    mov r7, 1
    shl r7, r6
    add r5, 0x0D00
    ldb r2, [r5+0]
    mov r3, r2
    and r3, r7
    cmp r3, 0
    je crfs_alloc_found
    add r4, 1
    jmp crfs_alloc_scan
crfs_alloc_found:
    or r2, r7
    stb [r5+0], r2
    push r4
    mov r1, 1
    call sda_write_block
    pop r4
    cmp r0, 0
    jne crfs_alloc_fail

    ; Clear scratch and initialize the new block with zeros
    mov r5, 0x0D00
    mov r6, 0
    mov r7, 0
crfs_alloc_zero:
    cmp r6, 256
    je crfs_alloc_commit
    stb [r5+0], r7
    add r5, 1
    add r6, 1
    jmp crfs_alloc_zero
crfs_alloc_commit:
    mov r1, r4
    push r4
    call sda_write_block
    pop r4
    cmp r0, 0
    jne crfs_alloc_fail
    mov r0, r4
    ret
crfs_alloc_fail:
    mov r0, 65535
    ret

; ---------------------------------------------------------------------------
; 只读 VFS：ls 用到的 getdents(2) 与 readview(8) 全部在这里用机器码完成。
; 与上面只认 sda 的 crfs_* 不同，它按设备工作：
;   0x0040 v_dev   当前设备号 (1 = sda, 2 = sdb…, 0xfe = rom)
;   0x0042 v_mult  该设备一块有几个 256 B 扇区 (sda 1, rom 4)
;   0x00C0..0x00DF 挂载表，8 项 x 4 字节：宿主设备、宿主 inode、被挂设备、v_mult
; 块控制器命令 6 按 256 B 扇区搬运，所以 1 KiB 块的 ROM 也能读进一页暂存区。
; inode 表总在第 3 块，每个 inode 48 字节；目录项 16 字节；uid 表在超级块偏移 32。

; vfs_setdev: r1 = 设备号。v_mult 取自挂载表，找不到按 1。破坏 r4 r5。
vfs_setdev:
    mov r4, 0
    stw [r4+0x0040], r1
    mov r5, 1
    stw [r4+0x0042], r5
    mov r4, 0x00C0
vfs_setdev_scan:
    cmp r4, 0x00E0
    je vfs_setdev_done
    ldb r5, [r4+2]
    cmp r5, r1
    je vfs_setdev_found
    add r4, 4
    jmp vfs_setdev_scan
vfs_setdev_found:
    ldb r5, [r4+3]
    mov r4, 0
    stw [r4+0x0042], r5
vfs_setdev_done:
    ret

; vfs_sector: r1 = 扇区号，读入 0x0D00。返回 0 / 0xffff。保留 r4，破坏 r5。
vfs_sector:
    push r4
    mov r4, 0
    ldw r5, [r4+0x0040]
    mov r4, 0xFE00
    stw [r4+2], r5
    stw [r4+4], r1
    mov r5, 0x0D00
    stw [r4+6], r5
    mov r5, 6           ; command 6 = READ one 256-byte sector
    stw [r4+0], r5
    ldw r0, [r4+8]
    cmp r0, 1
    jne vfs_sector_fail
    pop r4
    mov r0, 0
    ret
vfs_sector_fail:
    pop r4
    mov r0, 65535
    ret

; vfs_u8 / vfs_u16: r1 = 设备内绝对字节偏移。破坏 r1-r5。
vfs_u8:
    cmp r1, 61440
    jlt vfs_u8_body
    jmp vfs_u_fail
vfs_u8_body:
    mov r2, r1
    div r1, 256
    mod r2, 256
    push r2
    call vfs_sector
    pop r2
    cmp r0, 0
    jne vfs_u_fail
    add r2, 0x0D00
    ldb r0, [r2+0]
    ret
vfs_u16:
    cmp r1, 61440
    jlt vfs_u16_span
    jmp vfs_u_fail
vfs_u16_span:
    mov r2, r1
    div r1, 256
    mod r2, 256
    cmp r2, 255
    je vfs_u_fail
    push r2
    call vfs_sector
    pop r2
    cmp r0, 0
    jne vfs_u_fail
    add r2, 0x0D00
    ldw r0, [r2+0]
    ret
vfs_u_fail:
    mov r0, 65535
    ret

; vfs_inode: r1 = inode，r0 = inode 的绝对字节偏移。破坏 r1 r4。
; 越界时返回 0xFF00，后续 vfs_u8/vfs_u16 会拒绝，且这里不做会回绕的乘法。
vfs_inode:
    call ino_in_range
    cmp r0, 0
    jne vfs_inode_bad
    mov r4, 0
    ldw r0, [r4+0x0042]
    mul r0, 768         ; 3 blocks
    mul r1, 48
    add r0, r1
    ret
vfs_inode_bad:
    mov r0, 65280
    ret

; vfs_count: r1 = 目录 inode，r0 = 目录项个数或 0xffff。
vfs_count:
    call vfs_inode
    cmp r0, 65280
    je vfs_count_bad
    mov r1, r0
    add r1, 2
    call vfs_u16
    cmp r0, 65535
    je vfs_count_done
    div r0, 16
    ret
vfs_count_bad:
    mov r0, 65535
vfs_count_done:
    ret

; vfs_dirent: r1 = 目录 inode，r3 = 项序号。
; r0 = 子 inode (0 空槽，0xffff 出错)，r5 指向暂存区里 14 字节的名字。
vfs_dirent:
    mov r4, 0
    stw [r4+0x00B8], r3
    call ino_in_range
    cmp r0, 0
    jne vfs_dirent_fail
    call vfs_inode
    cmp r0, 65280
    je vfs_dirent_fail
    mov r4, 0
    ldw r5, [r4+0x0042]
    mul r5, 16          ; entries per block
    stw [r4+0x00BA], r5
    ldw r3, [r4+0x00B8]
    div r3, r5
    mul r3, 2
    mov r1, r0
    add r1, 8           ; ptr[entry / per_block]
    add r1, r3
    call vfs_u16
    cmp r0, 0
    je vfs_dirent_done
    cmp r0, 65535
    je vfs_dirent_done
    mov r4, 0
    ldw r5, [r4+0x0042]
    mul r0, r5          ; first sector of that block
    ldw r3, [r4+0x00B8]
    ldw r5, [r4+0x00BA]
    mod r3, r5
    div r3, 16          ; sector inside the block
    add r0, r3
    mov r1, r0
    call vfs_sector
    cmp r0, 0
    jne vfs_dirent_fail
    mov r4, 0
    ldw r5, [r4+0x00B8]
    mod r5, 16
    mul r5, 16
    add r5, 0x0D00
    ldw r0, [r5+0]
    add r5, 2
    cmp r0, 0
    je vfs_dirent_done
    mov r1, r0
    push r5
    call ino_in_range
    pop r5
    cmp r0, 0
    jne vfs_dirent_skip
    mov r0, r1
    jmp vfs_dirent_done
vfs_dirent_skip:
    mov r0, 0
vfs_dirent_done:
    ret
vfs_dirent_fail:
    mov r0, 65535
    ret

; vfs_lookup: r1 = 目录 inode，r2 = 用户态路径分量 (以 NUL 或 / 结束)。
vfs_lookup:
    mov r4, 0
    stw [r4+0x00BC], r1
    stw [r4+0x00BE], r2
    call vfs_count
    cmp r0, 65535
    je vfs_lookup_fail
    mov r4, 0
    stw [r4+0x00AA], r0
    stw [r4+0x00A8], r4
vfs_lookup_entry:
    mov r4, 0
    ldw r3, [r4+0x00A8]
    ldw r5, [r4+0x00AA]
    cmp r3, r5
    je vfs_lookup_fail
    add r3, 1
    stw [r4+0x00A8], r3
    sub r3, 1
    ldw r1, [r4+0x00BC]
    call vfs_dirent
    cmp r0, 0
    je vfs_lookup_entry
    cmp r0, 65535
    je vfs_lookup_fail
    mov r4, 0
    stw [r4+0x00B6], r0 ; child inode survives path_load
    ldw r2, [r4+0x00BE]
    mov r7, 0
vfs_lookup_name:
    cmp r7, 14
    je vfs_lookup_name_end
    ldb r6, [r5+0]
    push r2
    push r5
    push r6
    push r7
    mov r1, r2
    mov r2, 0
    call path_load
    pop r7
    pop r6
    pop r5
    pop r2
    mov r1, r0
    cmp r1, 0
    je vfs_lookup_user_end
    cmp r1, 47
    je vfs_lookup_user_end
    cmp r6, r1
    jne vfs_lookup_entry
    add r5, 1
    add r2, 1
    add r7, 1
    jmp vfs_lookup_name
vfs_lookup_user_end:
    cmp r6, 0
    jne vfs_lookup_entry
    jmp vfs_lookup_child
vfs_lookup_name_end:
    push r0
    push r2
    push r5
    mov r1, r2
    mov r2, 0
    call path_load
    mov r1, r0
    pop r5
    pop r2
    pop r0
    cmp r1, 0
    je vfs_lookup_child
    cmp r1, 47
    jne vfs_lookup_entry
vfs_lookup_child:
    mov r4, 0
    ldw r0, [r4+0x00B6]
    mov r1, r0
    call ino_in_range
    cmp r0, 0
    jne vfs_lookup_entry
    mov r0, r1
    ret
vfs_lookup_fail:
    mov r0, 65535
    ret

; vfs_cross_down: 当前 (v_dev, 0x00A2) 若是挂载点，换到被挂设备的根。
vfs_cross_down:
    mov r4, 0
    ldw r6, [r4+0x0040]
    ldw r7, [r4+0x00A2]
    mov r4, 0x00C0
vfs_down_scan:
    cmp r4, 0x00E0
    je vfs_down_done
    ldb r5, [r4+2]
    cmp r5, 0
    je vfs_down_next
    ldb r5, [r4+0]
    cmp r5, r6
    jne vfs_down_next
    ldb r5, [r4+1]
    cmp r5, r7
    jne vfs_down_next
    ldb r5, [r4+2]
    ldb r6, [r4+3]
    mov r4, 0
    stw [r4+0x0040], r5
    stw [r4+0x0042], r6
    mov r5, 1
    stw [r4+0x00A2], r5
vfs_down_done:
    ret
vfs_down_next:
    add r4, 4
    jmp vfs_down_scan

; vfs_cross_up: 0x00A2 换成父目录。被挂设备的根向上回到宿主挂载点的父目录。
vfs_cross_up:
    mov r4, 0
    ldw r7, [r4+0x00A2]
    cmp r7, 1
    jne vfs_up_parent
    ldw r6, [r4+0x0040]
    mov r4, 0x00C0
vfs_up_scan:
    cmp r4, 0x00E0
    je vfs_up_done      ; 根盘的根：.. 还是自己
    ldb r5, [r4+2]
    cmp r5, r6
    je vfs_up_host
    add r4, 4
    jmp vfs_up_scan
vfs_up_host:
    ldb r1, [r4+0]
    ldb r7, [r4+1]
    push r7
    call vfs_setdev
    pop r7
    mov r4, 0
    stw [r4+0x00A2], r7
    jmp vfs_cross_up
vfs_up_parent:
    mov r1, r7
    call ino_in_range
    cmp r0, 0
    jne vfs_up_done
    call vfs_inode
    cmp r0, 65280
    je vfs_up_done
    mov r1, r0
    add r1, 4           ; inode.parent
    call vfs_u16
    cmp r0, 65535
    je vfs_up_done
    mov r4, 0
    stw [r4+0x00A2], r0
vfs_up_done:
    ret

; vfs_resolve: r1 = 用户态路径 (0 表示当前目录)。r0 = inode 或 0xffff，
; 结果所在设备留在 v_dev / v_mult。沿途每级目录都要求搜索权。
; path_load: r1 = base, r2 = offset. Returns the path byte in r0.
; 0x0048 is 0 for a user pointer and 1 for a kernel pointer. Preserves r1 and r2.
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
    ldb r1, [r5+22]     ; cwd device
    ldb r6, [r5+23]     ; cwd inode
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
    mov r6, 1
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
    cmp r5, 46          ; "." and ".."
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
    ldw r1, [r4+0x00A2]
    call ino_in_range
    cmp r0, 0
    jne vfs_resolve_fail
    call vfs_inode
    cmp r0, 65280
    je vfs_resolve_fail
    mov r1, r0
    call vfs_u8
    cmp r0, 2           ; only directories have children
    jne vfs_resolve_fail
    mov r4, 0
    ldw r1, [r4+0x00A2]
    mov r2, ${M_EXEC}           ; owner exec
    mov r3, ${M_OEXEC}         ; other exec
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
    mov r2, ${M_EXEC}           ; "." / ".." 同样要搜索权
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
    stw [r4+0x0086], r2 ; user cursor
    stw [r4+0x0088], r3 ; max records
    call vfs_resolve
    cmp r0, 65535
    je getdents_failed
    mov r4, 0
    stw [r4+0x0084], r0
    mov r1, r0
    call vfs_inode
    mov r1, r0
    call vfs_u8
    cmp r0, 2
    jne getdents_failed
    mov r4, 0
    ldw r1, [r4+0x0084]
    mov r2, ${M_READ}           ; owner read
    mov r3, ${M_OREAD}
    call vfs_may
    cmp r0, 0
    jne getdents_failed
    mov r4, 0
    ldw r1, [r4+0x0084]
    call vfs_count
    cmp r0, 65535
    je getdents_failed
    mov r4, 0
    stw [r4+0x008C], r0 ; entries in the directory
    stw [r4+0x008A], r4 ; next entry
    stw [r4+0x008E], r4 ; records emitted
getdents_next:
    mov r4, 0
    ldw r5, [r4+0x008E]
    ldw r6, [r4+0x0088]
    cmp r5, r6
    je getdents_done
    ldw r3, [r4+0x008A]
    ldw r5, [r4+0x008C]
    cmp r3, r5
    je getdents_done
    add r3, 1
    stw [r4+0x008A], r3
    sub r3, 1
    ldw r1, [r4+0x0084]
    call vfs_dirent
    cmp r0, 0
    je getdents_next
    cmp r0, 65535
    je getdents_failed
    mov r4, 0
    stw [r4+0x0092], r0 ; child inode
    ldw r2, [r4+0x0086]
    mov r6, 0
getdents_name:
    cmp r6, 14
    je getdents_name_end
    ldb r7, [r5+0]
    ustb [r2+0], r7
    add r5, 1
    add r2, 1
    add r6, 1
    jmp getdents_name
getdents_name_end:
    mov r7, 0
    ustb [r2+0], r7
    ldw r1, [r4+0x0092]
    call vfs_inode
    cmp r0, 65280
    je getdents_next
    mov r4, 0
    stw [r4+0x009E], r0
    mov r1, r0
    call vfs_u8         ; type
    push r0
    mov r4, 0
    ldw r1, [r4+0x009E]
    cmp r1, 65280
    je getdents_next
    add r1, 1
    call vfs_u8         ; flags
    pop r6
    and r0, 1
    mul r0, 4
    or r6, r0
    mov r4, 0
    ldw r2, [r4+0x0086]
    ustb [r2+15], r6
    add r2, 16
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
    stw [r4+0x0090], r2
    stw [r4+0x0086], r3 ; user cursor
    stw [r4+0x0088], r3 ; user buffer start
    cmp r1, 8
    jne view_bridge
    mov r1, r2
    call vfs_resolve
    cmp r0, 65535
    je view_failed
    mov r4, 0
    stw [r4+0x0084], r0
    mov r1, r0
    call vfs_inode
    mov r1, r0
    call vfs_u8
    mov r4, 0
    stw [r4+0x0092], r0 ; type, needed for the trailing /
    mov r6, r0
    mov r0, 45          ; -
    cmp r6, 2
    jne view_type_dev
    mov r0, 100         ; d
view_type_dev:
    cmp r6, 3
    jne view_type_put
    mov r0, 99          ; c
view_type_put:
    call view_putc
    ldw r1, [r4+0x0084]
    call vfs_inode
    cmp r0, 65280
    je view_failed
    mov r1, r0
    add r1, 1
    call vfs_u8
    mov r6, r0          ; flags, kept in r6 by view_bit
    mov r4, 0
    ldw r1, [r4+0x0084]
    mov r2, r6
    call gp_cap_flags   ; a file cannot show bits its directory lacks
    mov r6, r0
    mov r1, 2
    mov r2, 114         ; owner r
    call view_bit
    mov r1, 4
    mov r2, 119         ; owner w
    call view_bit
    mov r1, 1
    mov r2, 120         ; owner x
    call view_bit
    mov r1, 8
    mov r2, 114         ; other r
    call view_bit
    mov r1, 16
    mov r2, 119         ; other w
    call view_bit
    mov r1, 128
    mov r2, 120         ; other x
    call view_bit
    mov r1, ${M_SETUID}
    mov r2, 115         ; setuid
    call view_bit
    mov r1, 64
    mov r2, 116         ; sticky
    call view_bit
    mov r0, 32
    call view_putc

    ; owner: uid table in the superblock of the same device
    ldw r1, [r4+0x0084]
    mul r1, 2
    add r1, ${SB_UID}
    call vfs_u16
    cmp r0, ${UID_ROOT}
    je view_root
    cmp r0, ${UID_USER}
    je view_user
    mov r1, r0
    mov r2, 5
    mov r3, 1           ; left aligned; other uids print as numbers
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
    jmp view_owner_pad
view_user:
    mov r0, ${UID_USER_NAME.charCodeAt(0)}
    call view_putc
    mov r0, ${UID_USER_NAME.charCodeAt(1)}
    call view_putc
    mov r0, ${UID_USER_NAME.charCodeAt(2)}
    call view_putc
    mov r0, ${UID_USER_NAME.charCodeAt(3)}
    call view_putc
    jmp view_owner_pad
view_owner_pad:
    mov r0, 32
    call view_putc
view_owner_done:
    mov r0, 32
    call view_putc

    ; size
    ldw r1, [r4+0x0084]
    call vfs_inode
    cmp r0, 65280
    je view_failed
    mov r1, r0
    add r1, 2
    call vfs_u16
    mov r1, r0
    mov r2, 5
    mov r3, 0           ; right aligned
    call view_num
    mov r0, 32
    call view_putc

    ; name: find this inode in its parent directory. A mounted root takes
    ; the name of its mount point; the root of sda is "/".
    ldw r7, [r4+0x0084]
    stw [r4+0x009E], r7
    cmp r7, 1
    jne view_name_parent
    ldw r6, [r4+0x0040]
    mov r4, 0x00C0
view_name_mnt:
    cmp r4, 0x00E0
    je view_name_root
    ldb r5, [r4+2]
    cmp r5, r6
    je view_name_host
    add r4, 4
    jmp view_name_mnt
view_name_root:
    mov r0, 47
    call view_putc
    jmp view_end
view_name_host:
    ldb r1, [r4+0]
    ldb r7, [r4+1]
    push r7
    call vfs_setdev
    pop r7
    mov r4, 0
    stw [r4+0x009E], r7
view_name_parent:
    mov r4, 0
    ldw r1, [r4+0x009E]
    call ino_in_range
    cmp r0, 0
    jne view_slash
    call vfs_inode
    cmp r0, 65280
    je view_slash
    mov r1, r0
    add r1, 4
    call vfs_u16        ; parent inode
    cmp r0, 65535
    je view_slash
    mov r4, 0
    stw [r4+0x0084], r0
    mov r1, r0
    call vfs_count
    cmp r0, 65535
    je view_slash
    mov r4, 0
    stw [r4+0x008C], r0
    stw [r4+0x008A], r4
view_name_entry:
    mov r4, 0
    ldw r3, [r4+0x008A]
    ldw r5, [r4+0x008C]
    cmp r3, r5
    je view_slash
    add r3, 1
    stw [r4+0x008A], r3
    sub r3, 1
    ldw r1, [r4+0x0084]
    call vfs_dirent
    mov r4, 0
    ldw r7, [r4+0x009E]
    cmp r0, r7
    jne view_name_entry
    mov r6, 0
view_name_copy:
    cmp r6, 14
    je view_slash
    ldb r0, [r5+0]
    cmp r0, 0
    je view_slash
    call view_putc
    add r5, 1
    add r6, 1
    jmp view_name_copy
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
    ldw r3, [r4+0x0086]
    mov r0, 0
    ustb [r3+0], r0     ; NUL after the line, not counted
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
    mov r7, 0x0096
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

; r1 = inode。0 表示 1 <= inode < 64，否则 0xffff。只改 r0。
ino_in_range:
    cmp r1, 0
    je ino_range_no
    cmp r1, ${SDA_INODES}
    jlt ino_range_yes
ino_range_no:
    mov r0, 65535
    ret
ino_range_yes:
    mov r0, 0
    ret

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
    call current_euid
    pop r1
    cmp r0, 0
    jne block_failed
    cmp r1, 254         ; rom 不能由系统调用整块读出
    je block_failed
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
    call current_euid
    pop r1
    cmp r0, 0
    jne block_failed
    cmp r1, 254         ; 0xfe = rom，固件不可由系统调用改写
    je block_failed
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
