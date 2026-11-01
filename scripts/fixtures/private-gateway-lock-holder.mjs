// Child process for a disposable, nonproduction crash-recovery fixture only.
import { acquirePrivateGatewayWriterLock } from '../../Server/private-gateway-writer-lock.mjs'

const root = process.argv[2]
if (!root) throw new Error('Disposable storage root argument required.')
acquirePrivateGatewayWriterLock(root)
process.stdout.write('PRIVATE_LOCK_ACQUIRED\n')
// Deliberately do not add an exit handler: the parent tests abrupt death.
setInterval(() => {}, 1000)
