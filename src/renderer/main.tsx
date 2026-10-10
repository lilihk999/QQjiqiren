import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

const container = document.getElementById('root');
if (container === null) throw new Error('缺少 #root 节点');
createRoot(container).render(<App />);
