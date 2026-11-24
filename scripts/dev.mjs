#!/usr/bin/env node
// Run the API server and the Vite client together (cross-platform, no extra dependencies).
import { spawn } from 'node:child_process'

const procs = [
  ['server', ['run', 'dev', '--workspace', 'server'], '\x1b[35m'],
  ['client', ['run', 'dev', '--workspace', 'client'], '\x1b[36m'],
].map(([name, args, color]) => {
  // A single command string through the shell works for npm on every platform (npm.cmd on Windows).
  const p = spawn(`npm ${args.join(' ')}`, { stdio: ['inherit', 'pipe', 'pipe'], shell: true })
  const prefix = `${color}[${name}]\x1b[0m `
  const pipe = (stream, out) => stream.on('data', (d) => out.write(d.toString().replace(/^(?=.)/gm, prefix)))
  pipe(p.stdout, process.stdout)
  pipe(p.stderr, process.stderr)
  p.on('exit', (code) => {
    console.log(`${prefix}exited with ${code}`)
    shutdown(code ?? 0)
  })
  return p
})

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const p of procs) p.kill()
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
