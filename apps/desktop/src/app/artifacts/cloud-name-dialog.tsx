import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'

interface CloudNameDialogProps {
  open: boolean
  creating: boolean
  name: string
  saving: boolean
  onName: (value: string) => void
  onClose: () => void
  onSave: () => void
}

/** 新建和重命名复用现有弹窗，名称与提交状态仍归资料库页面持有。 */
export function CloudNameDialog({ open, creating, name, saving, onName, onClose, onSave }: CloudNameDialogProps) {
  const { t } = useI18n()
  const label = creating ? t.cloudLibrary.createFolder : t.cloudLibrary.rename

  return (
    <Dialog
      onOpenChange={value => {
        if (!value && !saving) {
          onClose()
        }
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
        </DialogHeader>
        <Input aria-label={label} disabled={saving} onChange={event => onName(event.target.value)} value={name} />
        <DialogFooter>
          <Button disabled={saving} onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button disabled={saving || !name.trim()} onClick={onSave}>
            {t.common.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
