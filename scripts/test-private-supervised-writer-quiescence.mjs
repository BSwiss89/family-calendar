// Independent child processes and loopback sockets; no LIVE/TEST interaction.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { assertDisposableSupervisedWritersStopped } from '../Server/private-supervised-writer-quiescence.mjs'

async function reserve() {
  const srv = net.createServer()
  await new Promise((resolve,reject) => {
    srv.once('error',reject)
    srv.listen(0,'127.0.0.1',resolve)
  })
  const port = srv.address().port
  await new Promise(resolve => srv.close(resolve))
  if (port < 1024 || new Set([3001,13001,13002,13003,11434,443,8443]).has(port)) {
    throw new Error('OS supplied unsuitable port for disposable test.')
  }
  return port
}
function launch(id) {
  // No shell or external executables: just a long-lived test-only Node child.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide:true,stdio:'ignore'
  })
  return { child, householdId:id }
}
async function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('Disposable test process failed to exit.')),10000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.once('error',e => { clearTimeout(timer); reject(e) })
    if (!child.kill('SIGKILL')) { clearTimeout(timer); reject(new Error('Could not terminate test child.')) }
  })
}
async function fixture(t) {
  const backends=[launch('family-a'),launch('family-b')]
  t.after(async()=>{for(const b of backends)await killChild(b.child)})
  const ports = new Set()
  while (ports.size < 3) ports.add(await reserve())
  const [gatewayPort,portA,portB]=[...ports]
  const args={
    backends, backendPorts:{'family-a':portA,'family-b':portB},
    gatewayPort,gatewayClosed:true
  }
  return args
}

test('reject even one still-running supervised household writer', async t => {
  const args=await fixture(t)
  await killChild(args.backends[0].child)
  await assert.rejects(assertDisposableSupervisedWritersStopped(args),
    /process has not exited: family-b/)
  await killChild(args.backends[1].child)
  const checked=await assertDisposableSupervisedWritersStopped(args)
  assert.deepEqual(checked,{
    supervisedChildrenExited:true,loopbackListenersClosed:true,
    recoveryApproved:false,allSystemWritersFenced:false,
  })
})

test('refuse missing or duplicate child handles and unclosed gateway', async t => {
  const args=await fixture(t)
  await Promise.all(args.backends.map(b=>killChild(b.child)))
  await assert.rejects(assertDisposableSupervisedWritersStopped({
    ...args,backends:[args.backends[0]],
  }),/exactly two supervised/)
  await assert.rejects(assertDisposableSupervisedWritersStopped({
    ...args,backends:[args.backends[0],args.backends[0]],
  }),/duplicate or untrusted/)
  await assert.rejects(assertDisposableSupervisedWritersStopped({
    ...args,gatewayClosed:false,
  }),/closed gateway/)
  await assert.rejects(assertDisposableSupervisedWritersStopped({
    ...args,backendPorts:{'family-a':args.gatewayPort,'family-b':args.backendPorts['family-b']},
  }),/uniquely accounted/)
})

test('reject a different process accepting on a backend port after original exits', async t => {
  const args=await fixture(t)
  await Promise.all(args.backends.map(b=>killChild(b.child)))
  const port=args.backendPorts['family-b']
  const unrelated=net.createServer(socket=>socket.end())
  await new Promise((resolve,reject)=>{
    unrelated.once('error',reject)
    unrelated.listen(port,'127.0.0.1',resolve)
  })
  t.after(async()=>{if(unrelated.listening)await new Promise(resolve=>unrelated.close(resolve))})
  await assert.rejects(assertDisposableSupervisedWritersStopped(args),
    /Private service still accepts connections/)
  await new Promise(resolve=>unrelated.close(resolve))
  assert.equal((await assertDisposableSupervisedWritersStopped(args)).recoveryApproved,false)
})
