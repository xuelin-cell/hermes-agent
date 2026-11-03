import { getRuntimeI18nLocale } from '@/i18n/runtime'
import type { Locale } from '@/i18n/types'

// Auth, access, missing route/profile, startup, node, permissions, timeout, network.
type ErrorMessages = readonly [string, string, string, string, string, string, string, string]
const messages: Record<Locale, ErrorMessages> = {
  zh: ['登录已失效，请重新登录。', '当前账号无权访问该资源。', '专家配置或套件接口不存在，请检查安装状态和版本。', '云端实例或入口服务尚未就绪，请稍后重试。', '沙箱计算节点不健康，请联系管理员检查节点服务。', '沙箱引导遇到目录权限错误，请联系管理员更新或修复实例。', '沙箱操作超时，请稍后重试；持续失败请联系管理员。', '无法连接云端服务，请检查网络后重试。'],
  'zh-hant': ['登入已失效，請重新登入。', '目前帳號無權存取此資源。', '專家設定或套件介面不存在，請檢查安裝狀態與版本。', '雲端實例或入口服務尚未就緒，請稍後重試。', '沙箱運算節點異常，請聯絡管理員檢查節點服務。', '沙箱初始化遇到目錄權限錯誤，請聯絡管理員更新或修復實例。', '沙箱操作逾時，請稍後重試；持續失敗請聯絡管理員。', '無法連線至雲端服務，請檢查網路後重試。'],
  en: ['Your session expired. Sign in again.', 'Your account cannot access this resource.', 'The expert profile or kits endpoint was not found. Check installation and version.', 'The cloud instance or entry service is not ready. Try again shortly.', 'The sandbox compute node is unhealthy. Contact your administrator.', 'Sandbox startup failed because of directory permissions. Ask your administrator to update or repair the instance.', 'The sandbox operation timed out. Retry later; contact your administrator if it persists.', 'Cannot connect to the cloud service. Check your network and retry.'],
  ja: ['ログインが期限切れです。再ログインしてください。', 'このアカウントにはアクセス権がありません。', '専門家設定またはキットのAPIが見つかりません。インストールとバージョンを確認してください。', 'クラウドサービスの準備ができていません。後でもう一度お試しください。', 'サンドボックスの計算ノードに異常があります。管理者に連絡してください。', 'ディレクトリの権限により起動できません。管理者に更新または修復を依頼してください。', '操作がタイムアウトしました。再試行し、続く場合は管理者に連絡してください。', '接続できません。ネットワークを確認してください。'],
  de: ['Sitzung abgelaufen. Bitte erneut anmelden.', 'Dein Konto hat keinen Zugriff.', 'Expertenprofil oder Kit-Endpunkt fehlt. Installation und Version prüfen.', 'Der Cloud-Dienst ist noch nicht bereit. Später erneut versuchen.', 'Der Sandbox-Rechenknoten ist gestört. Administration kontaktieren.', 'Verzeichnisrechte verhindern den Start. Die Administration muss die Instanz aktualisieren oder reparieren.', 'Zeitüberschreitung. Später erneut versuchen; bei weiteren Fehlern die Administration kontaktieren.', 'Keine Verbindung zum Cloud-Dienst. Netzwerk prüfen.'],
  es: ['La sesión caducó. Inicia sesión de nuevo.', 'Tu cuenta no tiene acceso.', 'No se encontró el perfil o la API de kits. Revisa la instalación y la versión.', 'El servicio cloud aún no está listo. Reinténtalo más tarde.', 'El nodo del sandbox no está operativo. Contacta al administrador.', 'Los permisos de directorio impiden el inicio. Pide al administrador que actualice o repare la instancia.', 'La operación agotó el tiempo. Reinténtalo más tarde; si persiste, contacta al administrador.', 'No se pudo conectar. Revisa la red.'],
  fr: ['Session expirée. Reconnectez-vous.', 'Votre compte ne dispose pas des droits nécessaires.', 'Profil expert ou API des kits introuvable. Vérifiez l’installation et la version.', 'Le service cloud n’est pas prêt. Réessayez plus tard.', 'Le nœud de calcul du sandbox est défaillant. Contactez l’administrateur.', 'Les permissions du répertoire empêchent le démarrage. Demandez une mise à jour ou une réparation à l’administrateur.', 'L’opération a expiré. Réessayez plus tard ; si le problème persiste, contactez l’administrateur.', 'Connexion impossible. Vérifiez le réseau.'],
  ru: ['Сессия истекла. Войдите снова.', 'У вашей учётной записи нет доступа.', 'Профиль эксперта или API наборов не найден. Проверьте установку и версию.', 'Облачный сервис ещё не готов. Повторите позже.', 'Вычислительный узел песочницы неисправен. Обратитесь к администратору.', 'Права на каталог препятствуют запуску. Попросите администратора обновить или восстановить экземпляр.', 'Время операции истекло. Повторите позже; если ошибка останется, обратитесь к администратору.', 'Нет соединения с облачным сервисом. Проверьте сеть.'],
  ar: ['انتهت الجلسة. سجّل الدخول مجدداً.', 'ليس لحسابك إذن الوصول.', 'لم يتم العثور على إعداد الخبير أو واجهة الحزم. تحقق من التثبيت والإصدار.', 'الخدمة السحابية غير جاهزة. حاول لاحقاً.', 'عقدة الحوسبة غير سليمة. اتصل بالمسؤول.', 'تمنع أذونات المجلد بدء التشغيل. اطلب من المسؤول تحديث المثيل أو إصلاحه.', 'انتهت مهلة العملية. حاول لاحقاً واتصل بالمسؤول إن استمر الخطأ.', 'تعذر الاتصال بالخدمة. تحقق من الشبكة.']
}

const reasons: Record<string, number> = {
  sandbox_node_unhealthy: 4, sandbox_permission_denied: 5, sandbox_operation_timeout: 6
}

/** Never render upstream HTML, exception text, or credentials as boot copy. */
export async function browserBackendError(response: Response): Promise<Error> {
  const body: unknown = await response.json().catch(() => null)
  const data = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const statusIndex: Record<number, number> = { 401: 0, 403: 1, 404: 2, 408: 6, 504: 6 }
  const index = data.error === 'tenant_not_ready' && typeof data.reason === 'string' && Object.hasOwn(reasons, data.reason)
    ? reasons[data.reason] ?? 3 : statusIndex[response.status] ?? 3
  const code = ['tenant_not_ready', 'credential_sync_failed', 'database_unavailable'].includes(String(data.error)) ? ` · ${data.error}` : ''
  return new Error(`${messages[getRuntimeI18nLocale()][index]} (HTTP ${response.status}${code})`)
}

export async function fetchBrowserBackend(url: string): Promise<Response> {
  try {
    return await fetch(url, { credentials: 'same-origin', redirect: 'error', cache: 'no-store' })
  } catch {
    throw new Error(messages[getRuntimeI18nLocale()][7])
  }
}
