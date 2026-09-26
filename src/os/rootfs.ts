export const HELLO_S = `; hello.s — assemble with: as hello.s -o hello
.text
_start:
    mov r0, 1          ; syscall 1 = write
    mov r1, 1          ; fd 1 = stdout
    mov r2, msg        ; buffer address
    mov r3, 0          ; length 0 = up to the NUL byte
    sys
    mov r1, 0          ; exit status
    hlt

.data
msg:
    .asciz "hello from a real binary\\n"
`

export const COUNT_S = `; count.s — a loop, a syscall and a sleep
; build:  as count.s -o count      run:  ./count
.text
_start:
    mov r4, 0              ; counter
    mov r6, 0              ; base register for absolute stores
loop:
    cmp r4, 10
    jgt done

    mov r5, r4             ; render the digit into the buffer
    add r5, 48             ; 48 is ASCII '0'
    stb [r6+digit], r5     ; self-modifying data, written through the MMU
    mov r0, 1
    mov r1, 1
    mov r2, digit
    mov r3, 2
    sys

    mov r0, 6              ; syscall 6 = sleep
    mov r1, 4              ; 4 timer ticks, the process blocks
    sys

    add r4, 1
    jmp loop
done:
    mov r0, 1
    mov r1, 1
    mov r2, nl
    mov r3, 0
    sys
    mov r1, 0
    hlt

.data
digit:
    .byte 48
    .byte 32
    .byte 0
nl:
    .asciz "\\n"
`

export const PAGE_S = `; page.s — ask the CRX kernel allocator for virtual page 8
; build: as page.s -o page      run: ./page
.text
_start:
    mov r0, 29          ; page_alloc(vpn)
    mov r1, 8
    sys
    cmp r0, 65535
    je failed

    mov r4, r0          ; returned virtual address
    mov r5, 65          ; 'A'
    stb [r4+0], r5
    mov r5, 10
    stb [r4+1], r5

    mov r0, 1
    mov r1, 1
    mov r2, r4
    mov r3, 2
    sys

    mov r0, 31          ; page_free(vpn)
    mov r1, 8
    sys
    mov r1, 0
    hlt

failed:
    mov r0, 1
    mov r1, 2
    mov r2, err
    mov r3, 0
    sys
    mov r1, 1
    hlt

.data
err:
    .asciz "page_alloc failed\\n"
`

export const BLOCK_S = `; block.s — read the sda superblock through the CRX MMIO driver
; block_read requires euid 0, so the login shell (uid 1) is refused.
; build: as block.s -o block      run: ./block
.text
_start:
    mov r0, 29          ; page_alloc(vpn 8)
    mov r1, 8
    sys
    cmp r0, 65535
    je failed
    mov r4, r0          ; DMA buffer virtual address

    mov r0, 32          ; block_read(device, block, buffer)
    mov r1, 1           ; device 1 = sda
    mov r2, 0           ; superblock
    mov r3, r4
    sys
    cmp r0, 65535
    je failed

    mov r0, 1
    mov r1, 1
    mov r2, r4
    mov r3, 4           ; CRFS magic
    sys
    mov r0, 1
    mov r1, 1
    mov r2, nl
    mov r3, 1
    sys

    mov r0, 31
    mov r1, 8
    sys
    mov r1, 0
    hlt

failed:
    mov r0, 1
    mov r1, 2
    mov r2, err
    mov r3, 0
    sys
    mov r1, 1
    hlt

.data
nl:  .ascii "\\n"
err: .asciz "block read failed\\n"
`
