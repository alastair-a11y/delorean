import type { ReactNode } from 'react';

export default function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="row" style={{ marginBottom: 10 }}><h2 style={{ margin: 0 }}>{title}</h2><button className="ghost right" onClick={onClose}>✕</button></div>
        {children}
      </div>
    </div>
  );
}
