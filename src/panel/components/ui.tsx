// Lightweight shadcn/ui-styled primitives, self-contained (no @radix-ui) to
// keep the extension bundle small and dependency-light. Same class conventions
// and cn() helper as shadcn so they can be swapped later. See spec.md 10/11.
import {
  createContext,
  useContext,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TableHTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from 'react';
import { cn } from '../lib/cn';

// ---- Badge -------------------------------------------------------------
type BadgeVariant = 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline';
const badgeStyles: Record<BadgeVariant, string> = {
  default: 'bg-primary/15 text-primary border-primary/30',
  secondary: 'bg-muted text-muted-foreground border-transparent',
  success: 'bg-[hsl(var(--success))]/15 text-[hsl(var(--success))] border-[hsl(var(--success))]/30',
  warning: 'bg-[hsl(var(--warning))]/15 text-[hsl(var(--warning))] border-[hsl(var(--warning))]/30',
  destructive: 'bg-destructive/15 text-destructive border-destructive/30',
  outline: 'bg-transparent text-foreground border-border',
};
export function Badge({
  variant = 'default',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium leading-none',
        badgeStyles[variant],
        className
      )}
      {...props}
    />
  );
}

// ---- Button ------------------------------------------------------------
export function Button({
  className,
  variant = 'default',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'ghost' | 'outline' }) {
  const variants = {
    default: 'bg-primary text-primary-foreground hover:bg-primary/90',
    ghost: 'hover:bg-accent text-foreground',
    outline: 'border border-border hover:bg-accent text-foreground',
  };
  return (
    <button
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50',
        variants[variant],
        className
      )}
      {...props}
    />
  );
}

// ---- Input -------------------------------------------------------------
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring',
        className
      )}
      {...props}
    />
  );
}

// ---- Select (native) ---------------------------------------------------
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-7 rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring',
        className
      )}
      {...props}
    />
  );
}

// ---- Card --------------------------------------------------------------
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-border bg-card', className)} {...props} />;
}

// ---- Alert -------------------------------------------------------------
export function Alert({
  className,
  variant = 'default',
  children,
}: {
  className?: string;
  variant?: 'default' | 'warning' | 'destructive';
  children: ReactNode;
}) {
  const variants = {
    default: 'border-border bg-muted/40 text-foreground',
    warning: 'border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]',
    destructive: 'border-destructive/40 bg-destructive/10 text-destructive',
  };
  return (
    <div className={cn('rounded-md border px-3 py-2 text-xs', variants[variant], className)}>{children}</div>
  );
}

// ---- Tabs --------------------------------------------------------------
interface TabsCtx {
  value: string;
  setValue: (v: string) => void;
}
const TabsContext = createContext<TabsCtx | null>(null);

export function Tabs({
  value,
  onValueChange,
  className,
  children,
}: {
  value: string;
  onValueChange: (v: string) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <TabsContext.Provider value={{ value, setValue: onValueChange }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('inline-flex items-center gap-1 rounded-md bg-muted p-0.5', className)}>{children}</div>
  );
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  const ctx = useContext(TabsContext);
  if (!ctx) return null;
  const active = ctx.value === value;
  return (
    <button
      onClick={() => ctx.setValue(value)}
      className={cn(
        'rounded px-2.5 py-1 text-xs font-medium transition-colors',
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

export function TabsContent({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  const ctx = useContext(TabsContext);
  if (!ctx || ctx.value !== value) return null;
  return <div className={className}>{children}</div>;
}

// ---- Table -------------------------------------------------------------
export function Table({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full border-collapse text-xs', className)} {...props} />;
}
export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('sticky top-0 z-10 bg-card', className)} {...props} />;
}
export function TBody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}
export function TR({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('border-b border-border/60 hover:bg-accent/40', className)} {...props} />;
}
export function TH({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn('px-2 py-1.5 text-left font-semibold text-muted-foreground whitespace-nowrap', className)}
      {...props}
    />
  );
}
export function TD({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-2 py-1 align-top', className)} {...props} />;
}

// ---- Accordion (simple, uncontrolled) ----------------------------------
export function Accordion({ title, children, defaultOpen = false }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-md border border-border">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-2 py-1.5 text-left text-xs font-medium hover:bg-accent/40"
      >
        <span>{title}</span>
        <span className="text-muted-foreground">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="border-t border-border px-2 py-2">{children}</div>}
    </div>
  );
}

// ---- JSON viewer -------------------------------------------------------
export function Json({ value, className }: { value: unknown; className?: string }) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <pre className={cn('overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug', className)}>
      {text}
    </pre>
  );
}

// ---- Empty state -------------------------------------------------------
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
      <div className="text-sm font-medium text-foreground">{title}</div>
      {hint && <div className="max-w-md text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
