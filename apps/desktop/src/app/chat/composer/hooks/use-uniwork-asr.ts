import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import { asrPcm16 } from '@/lib/uniwork-asr-audio'
import { notifyError } from '@/store/notifications'

import type { AsrSnapshot } from '../../../../../electron/uniwork-asr/contract'
import { useComposerVisible } from '../visibility'

interface AsrDraftOptions {
  scope: string | null
  disabled: boolean
  readText: () => string
  replaceText: (text: string) => void
  language: 'zh' | 'en'
}

interface AsrCapture {
  token: number
  id: string | null
  stream: MediaStream | null
  context: AudioContext | null
  source: MediaStreamAudioSourceNode | null
  processor: ScriptProcessorNode | null
  timer: ReturnType<typeof setTimeout> | null
  base: string
  final: string
  interim: string
  sending: Promise<void>
  queued: number
  ending: boolean
}

/** 独立管理元景识别；切换会话或卸载时取消，迟到结果不能写进另一个草稿。 */
export function useUniworkAsr(options: AsrDraftOptions) {
  const visible = useComposerVisible()
  const latest = useRef(options)
  latest.current = options
  const epoch = useRef(0)
  const current = useRef<AsrCapture | null>(null)
  const [status, setStatus] = useState<'idle' | 'connecting' | 'recording' | 'finishing'>('idle')

  /** 先释放采集设备，再关闭网络；连接中的异步请求由代次检查回收。 */
  const cancel = useCallback(() => {
    epoch.current++
    const run = current.current
    current.current = null

    if (!run) {
      return
    }

    if (run.timer) {
      clearTimeout(run.timer)
    }

    if (run.processor) {
      run.processor.onaudioprocess = null
      run.processor.disconnect()
    }

    run.source?.disconnect()
    run.stream?.getTracks().forEach(track => track.stop())

    if (run.context) {
      void run.context.close().catch(() => undefined)
    }

    if (run.id) {
      void window.hermesDesktop?.uniworkAsr?.cancel(run.id).catch(() => undefined)
    }
  }, [])

  /** 中间结果替换当前句，最终结果追加一次，不重复叠加同一句。 */
  const apply = useCallback((snapshot: AsrSnapshot, token: number) => {
    const run = current.current

    if (!run || run.token !== token || epoch.current !== token) {
      return
    }

    if (snapshot.failed) {
      throw new Error('语音识别服务暂时不可用，请稍后重试。')
    }

    for (const part of snapshot.transcripts) {
      if (part.final) {
        run.final += part.text
        run.interim = ''
      } else {
        run.interim = part.text
      }
    }

    if (snapshot.transcripts.length) {
      latest.current.replaceText(run.base + run.final + run.interim)
    }
  }, [])

  /** 停止后仍接收尾句；只回填输入框，用户自行确认发送。 */
  const stop = useCallback(async () => {
    const run = current.current

    if (!run?.id) {
      cancel()
      setStatus('idle')

      return
    }

    if (run.ending) {
      return
    }

    run.ending = true
    setStatus('finishing')

    if (run.timer) {
      clearTimeout(run.timer)
      run.timer = null
    }

    if (run.processor) {
      run.processor.onaudioprocess = null
      run.processor.disconnect()
      run.processor = null
    }

    run.source?.disconnect()
    run.source = null
    run.stream?.getTracks().forEach(track => track.stop())
    run.stream = null

    if (run.context) {
      void run.context.close().catch(() => undefined)
      run.context = null
    }

    try {
      await run.sending
      const snapshot = await window.hermesDesktop!.uniworkAsr!.stop(run.id)
      apply(snapshot, run.token)
    } catch (error) {
      if (current.current === run) {
        notifyError(error, '语音识别失败')
      }
    } finally {
      if (current.current === run) {
        cancel()
        setStatus('idle')
      }
    }
  }, [apply, cancel])

  /** 点击后申请麦克风并连接固定服务，权限拒绝或取消时停止所有已创建资源。 */
  const start = useCallback(async () => {
    if (current.current || latest.current.disabled || !visible) {
      return
    }

    const bridge = window.hermesDesktop?.uniworkAsr

    if (!bridge || !navigator.mediaDevices?.getUserMedia) {
      notifyError(new Error('当前环境无法使用语音识别，请在桌面应用中重试。'), '语音识别失败')

      return
    }

    const token = ++epoch.current

    const run = {
      token,
      id: null as string | null,
      stream: null as MediaStream | null,
      context: null as AudioContext | null,
      source: null as MediaStreamAudioSourceNode | null,
      processor: null as ScriptProcessorNode | null,
      timer: null as ReturnType<typeof setTimeout> | null,
      base: latest.current.readText(),
      final: '',
      interim: '',
      sending: Promise.resolve(),
      queued: 0,
      ending: false
    }

    current.current = run
    setStatus('connecting')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        }
      })

      if (epoch.current !== token) {
        stream.getTracks().forEach(track => track.stop())

        return
      }

      run.stream = stream
      const id = await bridge.start(latest.current.language)

      if (epoch.current !== token) {
        await bridge.cancel(id)

        return
      }

      run.id = id
      run.context = new AudioContext()
      await run.context.resume()

      if (epoch.current !== token) {
        return
      }

      run.source = run.context.createMediaStreamSource(stream)
      // 与 Hexagent 相同的分块 PCM 协议；输出缓冲不写入声音，避免麦克风回放。
      run.processor = run.context.createScriptProcessor(4096, 1, 1)

      run.processor.onaudioprocess = event => {
        if (epoch.current !== token || !run.context) {
          return
        }

        const pcm = asrPcm16(event.inputBuffer.getChannelData(0), run.context.sampleRate)

        if (++run.queued > 16) {
          notifyError(new Error('语音识别网络过慢，请重试。'), '语音识别失败')
          cancel()
          setStatus('idle')

          return
        }

        run.sending = run.sending
          .then(async () => {
            if (epoch.current === token) {
              await bridge.audio(id, pcm)
            }
          })
          .catch(error => {
            if (epoch.current === token) {
              notifyError(error, '语音识别失败')
              cancel()
              setStatus('idle')
            }
          })
          .finally(() => {
            run.queued--
          })
      }

      run.source.connect(run.processor)
      run.processor.connect(run.context.destination)
      setStatus('recording')

      /** 串行拉取识别结果，避免慢请求重叠后覆盖新句子。 */
      const poll = async () => {
        try {
          const snapshot = await bridge.poll(id)
          apply(snapshot, token)

          if (epoch.current !== token || run.ending) {
            return
          }

          if (snapshot.closed) {
            cancel()
            setStatus('idle')

            return
          }

          run.timer = setTimeout(() => void poll(), 120)
        } catch (error) {
          if (epoch.current === token) {
            notifyError(error, '语音识别失败')
            cancel()
            setStatus('idle')
          }
        }
      }

      void poll()
    } catch (error) {
      if (epoch.current === token) {
        notifyError(error, '语音识别失败')
        cancel()
        setStatus('idle')
      }
    }
  }, [apply, cancel, visible])

  useLayoutEffect(() => {
    cancel()
    setStatus('idle')

    return cancel
  }, [options.scope, options.disabled, visible, cancel])

  return {
    status,
    toggle: () => {
      if (current.current) {
        void stop()
      } else {
        void start()
      }
    }
  }
}
