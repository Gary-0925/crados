// CRX 机器码内核 (Guest OS Kernel in CRX Machine Code)
//
// 运行在 supervisor 特权模式下。
// 内存布局 (Physical Memory Layout):
//   0x0000..0x003F : Kernel Control Block (KCB)
//     0x0000..0x001F : 引导标语 "crados 2.0\n"
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
//     0x003E : k_first_user_pfn (u16 = 31)
//     0x0040..0x0047 : k_frame_bitmap (64 frames = 8 bytes)
//   0x0100..0x0CFF : Process Control Block Table (16 PCBs x 192 bytes)
//   0x0D00..0x0DFF : Kernel Device Scratch Page
//   0x2800..0x3FFF : CRX Kernel Text (PFN 40..63, physical direct map)

export const GUEST_KERNEL_SOURCE = `.text
_start:
    cli
halt:
    hlt
    jmp halt

; 中断向量 0：系统调用入口 (sys 指令触发硬件特权切换进入此处)
syscall_entry:
    cli
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

    ; 其余复杂 I/O、文件系统等系统调用经特权服务桥分发
    svc
    iret

; write(fd, buf, len): 从当前 PCB 的 fd 表读取目标类型。
; tty/stdout/stderr 通过虚拟硬件 MMIO 端口输出；重定向到文件时交由 CRFS 桥。
;   0xFF00 = tty stdout data, 0xFF01 = tty stderr data
sys_write:
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
    ldb r6, [r3+42]     ; fd.device (base + fd*6 + 42)
    cmp r6, 1           ; native path currently supports sda
    je write_file

write_bridge:
    mov r0, 1
    svc
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

; open(path, O_RDONLY): CRX 内核直接解析 sda 的 CRFS 目录与 inode 表。
; 创建、截断、追加和 /bin ROM 挂载路径暂由兼容桥处理。
sys_open:
    mov r4, 0
    stw [r4+0x0074], r1 ; original path pointer
    cmp r2, 0
    jne open_bridge

    ; /bin is a separate ROM mount; VFS bridge handles it for now
    uldb r5, [r1+0]
    cmp r5, 47          ; '/'
    jne open_relative
    uldb r5, [r1+1]
    cmp r5, 98          ; b
    jne open_absolute
    uldb r5, [r1+2]
    cmp r5, 105         ; i
    jne open_absolute
    uldb r5, [r1+3]
    cmp r5, 110         ; n
    jne open_absolute
    uldb r5, [r1+4]
    cmp r5, 47
    je open_bridge

open_absolute:
    mov r6, 1           ; root inode
open_skip_root_slash:
    uldb r5, [r1+0]
    cmp r5, 47
    jne open_component
    add r1, 1
    jmp open_skip_root_slash

open_relative:
    call current_pcb
    ldb r5, [r5+22]     ; cwd device
    cmp r5, 1           ; native resolver handles sda
    jne open_bridge
    call current_pcb
    ldb r6, [r5+23]     ; cwd inode

open_component:
    uldb r5, [r1+0]
    cmp r5, 0
    je open_resolved
    mov r2, r1          ; component start
    push r1
    mov r1, r6          ; directory inode
    call crfs_lookup
    pop r1
    cmp r0, 65535
    je open_failed
    mov r6, r0          ; next inode

open_advance:
    uldb r5, [r1+0]
    cmp r5, 0
    je open_resolved
    add r1, 1
    cmp r5, 47
    jne open_advance
open_skip_slash:
    uldb r5, [r1+0]
    cmp r5, 47
    jne open_component
    add r1, 1
    jmp open_skip_slash

open_resolved:
    ; inode type must be regular file
    mov r5, r6
    mul r5, 48
    add r5, 768
    mov r1, r5
    call crfs_u8
    cmp r0, 1           ; T_FILE
    jne open_failed

    ; find free fd 3..7
    mov r4, 3
open_fd_scan:
    cmp r4, 8
    je open_failed
    call current_pcb
    mov r7, r4
    mul r7, 6
    add r5, 41
    add r5, r7
    ldb r0, [r5+0]
    cmp r0, 0
    je open_fd_found
    add r4, 1
    jmp open_fd_scan

open_fd_found:
    mov r0, 6           ; FK_FILE
    stb [r5+0], r0
    mov r0, 1           ; device sda
    stb [r5+1], r0
    stb [r5+2], r6      ; inode
    mov r0, 0
    stb [r5+3], r0      ; O_RDONLY
    stw [r5+4], r0      ; offset 0
    call current_pcb
    ldb r0, [r5+40]
    add r0, 1
    stb [r5+40], r0
    mov r0, r4          ; return fd
    iret

open_failed:
    mov r0, 65535
    iret
open_bridge:
    mov r4, 0
    ldw r1, [r4+0x0074]
    mov r0, 4
    svc
    iret

; sda regular-file write: update CRFS bitmap, inode direct pointer, data block,
; inode size and PCB fd offset. One syscall writes at most to the end of the
; current 256-byte block; libc-style callers retry the remainder.
write_file:
    ldb r6, [r3+44]     ; flags: 0=read, 1=write, 2=append
    cmp r6, 0
    je write_file_failed

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
    cmp r4, 1           ; only sda in native CRFS driver for now
    jne read_bridge

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
    mov r0, 2
    svc
    iret

; crfs_u16: read a big-endian u16 at absolute byte offset r1 from sda
crfs_u16:
    mov r2, r1
    div r1, 256         ; block
    mod r2, 256         ; offset
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

; Return 1 when the user path starts with /bin, otherwise 0.
is_bin_path:
    uldb r4, [r1+0]
    cmp r4, 47
    jne not_bin_path
    uldb r4, [r1+1]
    cmp r4, 98
    jne not_bin_path
    uldb r4, [r1+2]
    cmp r4, 105
    jne not_bin_path
    uldb r4, [r1+3]
    cmp r4, 110
    jne not_bin_path
    uldb r4, [r1+4]
    cmp r4, 0
    je bin_path
    cmp r4, 47
    jne not_bin_path
bin_path:
    mov r0, 1
    ret
not_bin_path:
    mov r0, 0
    ret

; Resolve an absolute or cwd-relative user path on sda. Returns inode or 0xffff.
crfs_resolve:
    uldb r5, [r1+0]
    cmp r5, 47
    je resolve_absolute
    call current_pcb
    ldb r4, [r5+22]
    cmp r4, 1
    jne resolve_failed
    ldb r6, [r5+23]
    jmp resolve_component
resolve_absolute:
    mov r6, 1
resolve_skip_slash:
    uldb r5, [r1+0]
    cmp r5, 47
    jne resolve_component
    add r1, 1
    jmp resolve_skip_slash
resolve_component:
    uldb r5, [r1+0]
    cmp r5, 0
    je resolve_done
    mov r2, r1
    push r1
    mov r1, r6
    call crfs_lookup
    pop r1
    cmp r0, 65535
    je resolve_failed
    mov r6, r0
resolve_advance:
    uldb r5, [r1+0]
    cmp r5, 0
    je resolve_done
    add r1, 1
    cmp r5, 47
    jne resolve_advance
resolve_skip_more:
    uldb r5, [r1+0]
    cmp r5, 47
    jne resolve_component
    add r1, 1
    jmp resolve_skip_more
resolve_done:
    mov r0, r6
    ret
resolve_failed:
    mov r0, 65535
    ret

; crfs_lookup: r1=directory inode, r2=user pointer to one path component.
; The component ends at NUL or '/'. Returns child inode or 0xffff.
crfs_lookup:
    mov r4, 0
    stw [r4+0x0076], r2 ; component pointer
    mov r5, r1
    mul r5, 48
    add r5, 768         ; directory inode global offset
    stw [r4+0x0078], r5

    mov r1, r5
    add r1, 2
    call crfs_u16       ; directory byte size
    cmp r0, 65535
    je crfs_lookup_fail
    div r0, 16          ; number of dirents
    mov r4, 0
    stw [r4+0x007A], r0
    mov r3, 0           ; entry index

crfs_lookup_entry:
    mov r4, 0
    ldw r5, [r4+0x007A]
    cmp r3, r5
    je crfs_lookup_fail

    ; direct pointer for dirent's data block: inode+8+(entry/16)*2
    mov r6, r3
    div r6, 16
    mul r6, 2
    ldw r1, [r4+0x0078]
    add r1, 8
    add r1, r6
    push r3
    call crfs_u16
    pop r3
    cmp r0, 0
    je crfs_lookup_next
    cmp r0, 65535
    je crfs_lookup_fail
    mov r1, r0
    push r3
    call sda_read_block
    pop r3
    cmp r0, 0
    jne crfs_lookup_fail

    ; dirent address = scratch + (entry % 16) * 16
    mov r5, r3
    mod r5, 16
    mul r5, 16
    add r5, 0x0D00
    ldw r6, [r5+0]      ; child inode
    cmp r6, 0
    je crfs_lookup_next
    add r5, 2           ; disk name
    mov r4, 0
    ldw r2, [r4+0x0076] ; user component pointer
    mov r7, 0

crfs_lookup_name:
    cmp r7, 14
    je crfs_lookup_name_end
    ldb r0, [r5+0]
    uldb r1, [r2+0]
    cmp r1, 0
    je crfs_lookup_user_end
    cmp r1, 47
    je crfs_lookup_user_end
    cmp r0, r1
    jne crfs_lookup_next
    add r5, 1
    add r2, 1
    add r7, 1
    jmp crfs_lookup_name

crfs_lookup_user_end:
    cmp r0, 0
    jne crfs_lookup_next
    mov r0, r6
    ret
crfs_lookup_name_end:
    uldb r1, [r2+0]
    cmp r1, 0
    je crfs_lookup_match
    cmp r1, 47
    jne crfs_lookup_next
crfs_lookup_match:
    mov r0, r6
    ret

crfs_lookup_next:
    add r3, 1
    jmp crfs_lookup_entry
crfs_lookup_fail:
    mov r0, 65535
    ret

; sda_read_block: r1=block, return 0 success or 0xffff
sda_read_block:
    mov r4, 0xFE00
    mov r5, 1           ; device 1 = sda
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
    mov r4, 0xFE00
    mov r5, 1
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

; tcsetpgrp: 设置前台进程组 PID
sys_tcsetpgrp:
    mov r4, 0
    stw [r4+0x002C], r1 ; k_fg_pid = r1
    mov r0, 0
    iret

; clock_gettime: 返回低位 ticks
sys_time:
    mov r4, 0
    ldw r0, [r4+0x0028] ; r0 = k_ticks_lo
    iret

; chmod(path, exec): resolve an sda path and update inode flags byte.
sys_chmod:
    mov r4, 0
    stw [r4+0x007C], r1 ; path
    stw [r4+0x007E], r2 ; execute flag
    call is_bin_path
    cmp r0, 1
    je chmod_bridge
    mov r4, 0
    ldw r1, [r4+0x007C]
    call crfs_resolve
    cmp r0, 65535
    je chmod_failed
    mul r0, 48
    add r0, 769         ; inode flags absolute offset
    stw [r4+0x0080], r0
    mov r1, r0
    call crfs_u8
    cmp r0, 65535
    je chmod_failed
    and r0, 254
    mov r4, 0
    ldw r2, [r4+0x007E]
    cmp r2, 0
    je chmod_store
    or r0, 1
chmod_store:
    mov r2, r0
    ldw r1, [r4+0x0080]
    call crfs_write_u8
    cmp r0, 0
    jne chmod_failed
    mov r0, 0
    iret
chmod_bridge:
    mov r4, 0
    ldw r1, [r4+0x007C]
    ldw r2, [r4+0x007E]
    mov r0, 15
    svc
    iret
chmod_failed:
    mov r0, 65535
    iret

; chdir(path): resolve an sda directory and store cwd device/inode in PCB.
sys_chdir:
    mov r4, 0
    stw [r4+0x007C], r1
    call is_bin_path
    cmp r0, 1
    je chdir_bridge
    mov r4, 0
    ldw r1, [r4+0x007C]
    call crfs_resolve
    cmp r0, 65535
    je chdir_failed
    mov r6, r0          ; inode
    mov r1, r0
    mul r1, 48
    add r1, 768
    call crfs_u8
    cmp r0, 2           ; T_DIR
    jne chdir_failed
    call current_pcb
    mov r4, 1           ; sda device code
    stb [r5+22], r4
    stb [r5+23], r6
    mov r0, 0
    iret
chdir_bridge:
    mov r4, 0
    ldw r1, [r4+0x007C]
    mov r0, 23
    svc
    iret
chdir_failed:
    mov r0, 65535
    iret

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

    ; 从 KCB 指定的首个用户帧开始扫描物理帧位图
    mov r4, 0
    ldw r4, [r4+0x003E] ; pfn = k_first_user_pfn
page_scan:
    cmp r4, 64
    je page_failed
    mov r5, r4
    div r5, 8           ; bitmap byte index
    mov r6, r4
    mod r6, 8           ; bitmap bit index
    mov r7, 1
    shl r7, r6          ; mask
    add r5, 0x0040      ; bitmap address
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

    ; 写入当前 PCB 的页表项: VALID(0x80) | PFN
    mov r5, 0
    ldw r6, [r5+0x0022]
    mul r6, 192
    add r6, 0x0100      ; PCB
    mov r5, r6
    add r5, 24
    add r5, r3          ; PTE address
    mov r7, r4
    or r7, 128
    stb [r5+0], r7
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
    and r4, 63          ; PFN
    mov r7, 0
    ldw r7, [r7+0x003E]
    cmp r4, r7
    jlt page_free_failed

    mov r7, 0
    stb [r6+0], r7      ; clear PTE
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
    add r5, 0x0040
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
    cmp r1, 1           ; pid 1 (init) 保护
    je kill_init
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
    svc                 ; 释放映射页并回收
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
