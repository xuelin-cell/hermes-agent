/** 绑定只在主进程交接；与模型目录和 Renderer 的套餐展示分开。 */
export interface UniAgentGateBinding {
  gatewayUrl: string
  agentId: string
  agentSk: string
}

export type UniAgentGateUpdate =
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'clear' }
  | { status: 'available'; binding: UniAgentGateBinding }

/** 只接受字段对象，不把数组/空值当作绑定载荷。 */
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 缺失保留，显式 null 撤销，坏字段不覆盖最后可用绑定；不消费 cloud 凭据。 */
export function parseUniAgentGate(value: unknown): UniAgentGateUpdate {
  if (!record(value)) {
    return { status: 'missing' }
  }

  const legacy = Object.hasOwn(value, 'uniagentgate')
  const fields = ['ipUrl', 'agentIdPersonal', 'agentKeyPersonal']

  if (!legacy && !fields.some(name => Object.hasOwn(value, name))) {
    return { status: 'missing' }
  }

  const raw = legacy
    ? value.uniagentgate
    : {
        gateway_url: value.ipUrl,
        agent_id: value.agentIdPersonal,
        agent_sk: value.agentKeyPersonal
      }

  if (raw === null) {
    return { status: 'clear' }
  }

  if (
    !record(raw) ||
    ['gateway_url', 'agent_id', 'agent_sk'].some(
      name => typeof raw[name] !== 'string' || !raw[name].trim() || /[^\x20-\x7e]/.test(raw[name] as string)
    )
  ) {
    return { status: 'invalid' }
  }

  try {
    const url = new URL(raw.gateway_url as string)

    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (raw.agent_sk as string).includes('${')
    ) {
      return { status: 'invalid' }
    }

    return {
      status: 'available',
      binding: {
        gatewayUrl: url.href.replace(/\/+$/, ''),
        agentId: (raw.agent_id as string).trim(),
        agentSk: (raw.agent_sk as string).trim()
      }
    }
  } catch {
    return { status: 'invalid' }
  }
}
