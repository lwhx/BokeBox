type Props = {
  label: string;
  fading?: boolean;
  className?: string;
};

export function GraphLoader({ label, fading = false, className }: Props) {
  return (
    <div
      className={['tg-loader', fading ? 'is-fading' : '', className].filter(Boolean).join(' ')}
      role="status"
      aria-live="polite"
      aria-busy={!fading}
    >
      <div className="tg-loader-grid" aria-hidden="true">
        <span className="tg-loader-line tg-loader-line-a" />
        <span className="tg-loader-line tg-loader-line-b" />
        <span className="tg-loader-line tg-loader-line-c" />
        <i className="tg-loader-node tg-loader-node-a" />
        <i className="tg-loader-node tg-loader-node-b" />
        <i className="tg-loader-node tg-loader-node-c" />
      </div>
      <p>{label}</p>
    </div>
  );
}
