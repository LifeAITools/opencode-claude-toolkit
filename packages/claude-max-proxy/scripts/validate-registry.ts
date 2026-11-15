// Проверка реестра провайдеров ДО выкладки: разбирает файл тем же разборщиком, что и служба.
// Выход 0 — читается; 1 — нет (печатает причину). Зовётся из deploy-from-source.sh.
import { loadProviderRegistry } from '../src/provider-registry.ts'
const path = process.argv[2]
if (!path) { console.error('usage: validate-registry.ts <providers.yaml>'); process.exit(2) }
try {
  const r = loadProviderRegistry(path)
  console.log(`registry OK: ${Object.keys((r as any).providers ?? {}).length || 'n/a'} providers`)
} catch (e) { console.error(`registry NOT READABLE: ${(e as Error).message}`); process.exit(1) }
