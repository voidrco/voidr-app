import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
}) {
  return (
    <button className={`vdr-btn vdr-btn-${variant} vdr-btn-${size} ${className}`} {...props}>
      {icon}
      {children}
    </button>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'live';
  children: ReactNode;
}) {
  return <span className={`vdr-badge vdr-badge-${tone}`}>{children}</span>;
}

export function Panel({
  title,
  subtitle,
  action,
  children,
  className = '',
  ...props
}: HTMLAttributes<HTMLElement> & {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <section className={`vdr-panel ${className}`} {...props}>
      {(title || action) && (
        <header className="vdr-panel-header">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="vdr-panel-body">{children}</div>
    </section>
  );
}

export function VoidrBrand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="vdr-brand" aria-label="Voidr Capture">
      <img src="./logo-light.svg" alt="Voidr" />
      {!compact && <span>Capture</span>}
    </div>
  );
}

export function StatusDot({ live = false }: { live?: boolean }) {
  return <span className={`vdr-status-dot${live ? ' vdr-status-dot-live' : ''}`} aria-hidden="true" />;
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
}: {
  tabs: Array<{ value: T; label: string; icon?: ReactNode }>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="vdr-tabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          className={`vdr-tab${value === tab.value ? ' active' : ''}`}
          onClick={() => onChange(tab.value)}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  );
}

const markPath = 'M141.5 283C219.648 283 283 219.649 283 141.5C283 63.3518 219.648 0 141.5 0C63.3518 0 0 63.3518 0 141.5C0 219.649 63.3518 283 141.5 283ZM208.713 126.714C208.713 134.88 202.093 141.5 193.927 141.5H156.77C148.604 141.5 141.983 148.12 141.983 156.287V193.926C141.983 202.092 135.364 208.712 127.198 208.712H89.0745C80.9076 208.712 74.2876 202.092 74.2876 193.926V156.287C74.2876 148.12 80.9076 141.5 89.0745 141.5H126.23C134.397 141.5 141.017 134.88 141.017 126.714V89.0746C141.017 80.9077 147.637 74.2877 155.804 74.2877H193.927C202.093 74.2877 208.713 80.9077 208.713 89.0746V126.714Z';

export function VoidrMark({ size = 28, active = false }: { size?: 24 | 28 | 30 | 40 | 56; active?: boolean }) {
  return (
    <span className={`vdr-mark vdr-mark-${size}${active ? ' vdr-mark-active' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 283 283">
        <path fillRule="evenodd" clipRule="evenodd" d={markPath} />
      </svg>
    </span>
  );
}

export function Toast({
  tone = 'info',
  title,
  message,
  onClose,
}: {
  tone?: 'success' | 'warning' | 'error' | 'info';
  title: string;
  message?: string;
  onClose?: () => void;
}) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'warning' ? AlertTriangle : tone === 'error' ? XCircle : Info;
  return (
    <div className={`vdr-toast vdr-toast-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon className="vdr-toast-icon" size={17} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        {message && <p>{message}</p>}
      </div>
      {onClose && <button type="button" onClick={onClose} aria-label="Fechar"><X size={14} /></button>}
    </div>
  );
}
