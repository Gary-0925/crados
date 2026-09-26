import readmeEn from './README.md?raw'
import readmeZh from './README.zh.md?raw'
import asmEn from './asm.md?raw'
import asmZh from './asm.zh.md?raw'
import storageEn from './storage.md?raw'
import storageZh from './storage.zh.md?raw'
import inspectEn from './inspect.md?raw'
import inspectZh from './inspect.zh.md?raw'
import scriptEn from './script.md?raw'
import scriptZh from './script.zh.md?raw'
import manEn from './man.md?raw'
import manZh from './man.zh.md?raw'

export interface ManPage {
  name: string
  body: string
}

export const MAN_PAGES: ManPage[] = [
  { name: 'README', body: readmeEn },
  { name: 'README.zh', body: readmeZh },
  { name: 'asm', body: asmEn },
  { name: 'asm.zh', body: asmZh },
  { name: 'storage', body: storageEn },
  { name: 'storage.zh', body: storageZh },
  { name: 'inspect', body: inspectEn },
  { name: 'inspect.zh', body: inspectZh },
  { name: 'script', body: scriptEn },
  { name: 'script.zh', body: scriptZh },
  { name: 'man', body: manEn },
  { name: 'man.zh', body: manZh },
]

export const MAN_FILES: [string, string][] = MAN_PAGES.map(({ name, body }) => [
  `/usr/man/${name}.md`,
  body,
])
