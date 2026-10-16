import { cva, type VariantProps } from 'class-variance-authority'

// 表单控件共用主题圆角、字号和行高，小尺寸变体仍可显式覆盖。
export const controlVariants = cva(
  'desktop-input-chrome w-full min-w-0 rounded-[var(--control-radius,2.5px)] border text-[length:var(--control-font-size,0.75rem)] leading-[var(--control-line-height,1rem)] text-foreground outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      size: {
        xs: 'px-2 py-0.5 text-[0.6875rem] leading-4',
        sm: 'px-2 py-1',
        default: 'px-2.5 py-1.5',
        lg: 'px-3 py-2 text-sm leading-5',
        auth: 'min-h-11 rounded-[0.625rem] px-3.5 py-2.5 text-sm leading-5'
      }
    },
    defaultVariants: {
      size: 'default'
    }
  }
)

export type ControlVariantProps = VariantProps<typeof controlVariants>
