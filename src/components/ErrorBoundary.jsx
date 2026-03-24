import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("ErrorBoundary caught an error:", error, info);
    this.setState({ error, info });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 20, color: 'white', background: '#991b1b', height: '100vh', width: '100vw', boxSizing: 'border-box', overflow: 'auto' }}>
          <h2>UI Crashed! (React Error Boundary)</h2>
          <p>This explains why the screen went blank. Please share this error.</p>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13, background: 'rgba(0,0,0,0.2)', padding: 15, borderRadius: 8 }}>
            <span style={{color: '#f87171', fontWeight: 'bold'}}>{this.state.error && this.state.error.toString()}</span>
            <br />
            {this.state.info && this.state.info.componentStack}
          </pre>
          <button 
            onClick={() => window.location.reload()} 
            style={{ padding: '8px 16px', marginTop: 15, background: '#ef4444', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}
          >
            Reload App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
