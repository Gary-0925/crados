import readmeEn from './README?raw'
import readmeZh from './README.zh?raw'
import asmEn from './asm?raw'
import asmZh from './asm.zh?raw'
import storageEn from './storage?raw'
import storageZh from './storage.zh?raw'
import inspectEn from './inspect?raw'
import inspectZh from './inspect.zh?raw'
import scriptEn from './script?raw'
import scriptZh from './script.zh?raw'
import manEn from './man?raw'
import manZh from './man.zh?raw'

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
  `/usr/man/${name}`,
  body,
])
