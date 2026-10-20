export interface UniAgentGateReconnectResult {
  status: 'connected' | 'connecting' | 'busy' | 'failed' | 'unbound' | 'unavailable' | 'stopped' | 'restart_required'
}
