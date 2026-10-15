/** 沿用 UniWork 协议，将单声道浮点采样转成 16kHz 小端 PCM16。 */
export function asrPcm16(input: Float32Array, sourceRate: number): Uint8Array {
  const ratio = sourceRate / 16000
  const count = Math.round(input.length / ratio)
  const buffer = new ArrayBuffer(count * 2)
  const output = new DataView(buffer)
  let start = 0

  for (let index = 0; index < count; index++) {
    const end = Math.min(input.length, Math.round((index + 1) * ratio))
    let total = 0

    for (let offset = start; offset < end; offset++) {
      total += input[offset]!
    }

    const value = Math.max(-1, Math.min(1, total / Math.max(1, end - start)))
    output.setInt16(index * 2, value < 0 ? value * 32768 : value * 32767, true)
    start = end
  }

  return new Uint8Array(buffer)
}
