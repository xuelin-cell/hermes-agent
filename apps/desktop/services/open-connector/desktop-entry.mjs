// The desktop owns this process, including an unexpected parent termination.
if (process.connected) process.once('disconnect', () => process.exit(0))
await import('./src/server/index.ts')
