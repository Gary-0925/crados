// Measure the assembled CRX kernel image size against KERNEL_TEXT_PAGES * PAGE_SIZE.
import { loadKernelModule } from './harness.mjs'

const { server, mod } = await loadKernelModule()
try {
  const { assemble } = await server.ssrLoadModule('/src/os/isa.ts')
  const { KERNEL_TEXT_PAGES, PAGE_SIZE } = await server.ssrLoadModule('/src/os/memory.ts')
  const limit = KERNEL_TEXT_PAGES * PAGE_SIZE
  const { GUEST_KERNEL_SOURCE } = await server.ssrLoadModule('/src/os/guestkernel.ts')
  const { GUEST_POLICY_SOURCE } = await server.ssrLoadModule('/src/os/guestpolicy.ts')
  const built = assemble(GUEST_KERNEL_SOURCE + GUEST_POLICY_SOURCE)
  if (built.errors.length) {
    console.log('ASM ERRORS:')
    for (const e of built.errors) console.log('  ' + e)
    process.exit(1)
  }
  const image = built.bytes.length - 16
  console.log(`kernel image: ${image} bytes (limit ${limit}, headroom ${limit - image})`)
  // also assemble every /bin program
  const { ASM_PROGRAMS } = await server.ssrLoadModule('/src/os/asmsrc.ts')
  let bad = 0
  for (const [name, src] of Object.entries(ASM_PROGRAMS)) {
    const r = assemble(src)
    if (r.errors.length) {
      bad++
      console.log(`${name}: ${r.errors[0]}`)
    }
  }
  console.log(bad ? `${bad} programs failed` : `all ${Object.keys(ASM_PROGRAMS).length} programs assemble`)
} finally {
  await server.close()
}
