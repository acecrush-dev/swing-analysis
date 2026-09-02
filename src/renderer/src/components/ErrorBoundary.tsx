import { Component, ReactNode } from 'react';

interface Props { children: ReactNode; }
interface State { error: Error | null; }

/**
 * Catches any render-time exception thrown by descendants and shows
 * the message instead of unmounting the entire React tree (which would
 * leave a blank white window). Specifically guards against:
 *   - undefined property access (e.g. `s.seg_id` on a malformed WS event)
 *   - null-deref during heavy re-renders
 *   - any unexpected layout/JSX problem in deeply nested children
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: any) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] caught:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 24,
          background: '#1a1a1a',
          color: '#f88',
          height: '100vh',
          fontFamily: 'system-ui',
        }}>
          <h2 style={{ color: '#fa3' }}>渲染错误</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: '#222', padding: 12, borderRadius: 4 }}>
            {String(this.state.error?.message ?? this.state.error)}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: 12, padding: '6px 16px' }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}