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

const wordmarkPath = 'M379.62 208.922L348.89 115.65H374.952L397.32 191.621H400.82L423.188 115.65H449.251L418.52 208.922H379.62ZM509.002 211.555C499.407 211.555 490.784 209.674 483.133 205.913C475.484 202.152 469.454 196.699 465.045 189.553C460.637 182.408 458.432 173.819 458.432 163.791V160.782C458.432 150.752 460.637 142.165 465.045 135.019C469.454 127.873 475.484 122.42 483.133 118.659C490.784 114.898 499.407 113.017 509.002 113.017C518.598 113.017 527.221 114.898 534.871 118.659C542.522 122.42 548.55 127.873 552.959 135.019C557.368 142.165 559.572 150.752 559.572 160.782V163.791C559.572 173.819 557.368 182.408 552.959 189.553C548.55 196.699 542.522 202.152 534.871 205.913C527.221 209.674 518.598 211.555 509.002 211.555ZM509.002 190.493C516.523 190.493 522.747 188.174 527.675 183.536C532.602 178.771 535.066 172.002 535.066 163.226V161.345C535.066 152.57 532.602 145.863 527.675 141.224C522.877 136.461 516.653 134.079 509.002 134.079C501.482 134.079 495.258 136.461 490.331 141.224C485.403 145.863 482.939 152.57 482.939 161.345V163.226C482.939 172.002 485.403 178.771 490.331 183.536C495.258 188.174 501.482 190.493 509.002 190.493ZM582.193 208.922V115.65H606.7V208.922H582.193ZM594.447 104.743C590.038 104.743 586.278 103.364 583.166 100.606C580.184 97.8479 578.693 94.2123 578.693 89.6992C578.693 85.186 580.184 81.5504 583.166 78.7924C586.278 76.0343 590.038 74.6553 594.447 74.6553C598.985 74.6553 602.745 76.0343 605.728 78.7924C608.711 81.5504 610.202 85.186 610.202 89.6992C610.202 94.2123 608.711 97.8479 605.728 100.606C602.745 103.364 598.985 104.743 594.447 104.743ZM672.758 211.555C665.108 211.555 657.912 209.737 651.169 206.101C644.556 202.34 639.239 196.887 635.22 189.741C631.2 182.595 629.19 173.945 629.19 163.791V160.782C629.19 150.627 631.2 141.977 635.22 134.831C639.239 127.685 644.556 122.295 651.169 118.659C657.782 114.898 664.978 113.017 672.758 113.017C678.593 113.017 683.456 113.707 687.345 115.086C691.365 116.339 694.607 117.969 697.071 119.975C699.535 121.98 701.414 124.112 702.711 126.368H706.212V77.288H730.722V208.922H706.601V197.639H703.101C700.896 201.149 697.46 204.346 692.792 207.23C688.253 210.113 681.575 211.555 672.758 211.555ZM680.149 190.87C687.67 190.87 693.958 188.55 699.016 183.912C704.073 179.147 706.601 172.253 706.601 163.226V161.345C706.601 152.32 704.073 145.487 699.016 140.848C694.088 136.085 687.799 133.703 680.149 133.703C672.628 133.703 666.34 136.085 661.283 140.848C656.225 145.487 653.697 152.32 653.697 161.345V163.226C653.697 172.253 656.225 179.147 661.283 183.912C666.34 188.55 672.628 190.87 680.149 190.87ZM757.887 208.922V115.65H782.006V126.181H785.506C786.932 122.42 789.266 119.662 792.508 117.906C795.879 116.151 799.77 115.273 804.179 115.273H815.848V136.336H803.79C797.566 136.336 792.443 137.965 788.424 141.224C784.404 144.358 782.394 149.248 782.394 155.893V208.922H757.887Z';

const markPath = 'M141.5 283C219.648 283 283 219.649 283 141.5C283 63.3518 219.648 0 141.5 0C63.3518 0 0 63.3518 0 141.5C0 219.649 63.3518 283 141.5 283ZM208.713 126.714C208.713 134.88 202.093 141.5 193.927 141.5H156.77C148.604 141.5 141.983 148.12 141.983 156.287V193.926C141.983 202.092 135.364 208.712 127.198 208.712H89.0745C80.9076 208.712 74.2876 202.092 74.2876 193.926V156.287C74.2876 148.12 80.9076 141.5 89.0745 141.5H126.23C134.397 141.5 141.017 134.88 141.017 126.714V89.0746C141.017 80.9077 147.637 74.2877 155.804 74.2877H193.927C202.093 74.2877 208.713 80.9077 208.713 89.0746V126.714Z';

export function VoidrLogo() {
  return (
    <svg className="vdr-logo" viewBox="0 0 816 283" aria-hidden="true" focusable="false">
      <path d={wordmarkPath} />
      <path fillRule="evenodd" clipRule="evenodd" d={markPath} />
    </svg>
  );
}

export function VoidrBrand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="vdr-brand" aria-label="Voidr Capture">
      <VoidrLogo />
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
