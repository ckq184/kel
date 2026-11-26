import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Globe, Sparkles } from 'lucide-react';
import { useAuthStore } from '../stores/auth';
import { LogoLoading } from '../components/common/LogoLoading';
import { extractErrorMessage } from '../utils/error';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

export function LoginPage() {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);
  const initialized = useAuthStore((state) => state.initialized);
  const checkStatus = useAuthStore((state) => state.checkStatus);

  // Login fields
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  useEffect(() => {
    if (initialized === null) {
      checkStatus();
    } else if (initialized === false) {
      navigate('/setup', { replace: true });
    }
  }, [initialized, checkStatus, navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login(loginUsername, loginPassword);
      const state = useAuthStore.getState();
      if (state.setupStatus?.needsSetup) {
        navigate('/setup/providers');
        return;
      }
      navigate('/chat');
    } catch (err) {
      setError(extractErrorMessage(err) || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  if (initialized !== true) {
    return <LogoLoading full />;
  }

  return (
    <div className="landing-page min-h-screen bg-background overflow-y-auto relative">
      {/* ── Background noise grain ── */}
      <div className="landing-gradient-bg" aria-hidden="true" />

      {/* ── Aurora blobs ── */}
      <div className="landing-aurora" aria-hidden="true">
        <div className="landing-aurora-blob landing-aurora-blob-1" />
        <div className="landing-aurora-blob landing-aurora-blob-2" />
        <div className="landing-aurora-blob landing-aurora-blob-3" />
        <div className="landing-aurora-blob landing-aurora-blob-4" />
      </div>

      {/* ── Top nav bar ── */}
      <header className="relative z-10 flex items-center justify-between px-6 py-4 lg:px-12">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl overflow-hidden">
            <img
              src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
              alt="CKQClaw"
              className="w-full h-full object-cover"
            />
          </div>
          <span className="text-lg font-semibold text-foreground tracking-tight">
            CKQClaw
          </span>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="https://github.com/ckq184/ckqclaw"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button variant="ghost" size="sm">
              <Globe className="size-4" />
              <span className="hidden sm:inline">GitHub</span>
            </Button>
          </a>
        </div>
      </header>

      {/* ── Hero + Auth section ── */}
      <main className="relative z-10 px-5 sm:px-6 lg:px-12 pt-4 pb-8 lg:pt-16 lg:pb-16 flex-1 flex items-start lg:items-center">
        <div className="mx-auto max-w-6xl w-full">
          {/* Mobile: card-first compact layout / Desktop: side-by-side */}
          <div className="flex flex-col-reverse lg:grid lg:grid-cols-2 gap-8 lg:gap-20 items-center lg:items-start lg:pt-12">
            {/* Left: Hero text — below card on mobile */}
            <div className="text-center lg:text-left">
              <div className="landing-badge">
                <Sparkles className="size-3.5" />
                <span>Powered by Pi Agent Runtime</span>
              </div>

              <h1 className="mt-4 lg:mt-6 text-3xl sm:text-4xl lg:text-6xl font-bold text-foreground tracking-tight leading-[1.1]">
                你的私有
                <br />
                <span className="landing-gradient-text">AI 智能体平台</span>
              </h1>

              <p className="mt-4 lg:mt-6 text-sm sm:text-base lg:text-lg text-muted-foreground leading-relaxed max-w-lg mx-auto lg:mx-0">
                自托管、多渠道 —— 让 CKQClaw 成为你的全能数字助手。
                在安全隔离的环境中，自主执行代码、管理文件、调度任务。
              </p>

              {/* Stats — hidden on small mobile to save space */}
              <div className="mt-6 lg:mt-8 hidden sm:flex items-center justify-center lg:justify-start gap-6 lg:gap-8">
                <div>
                  <div className="text-xl lg:text-2xl font-bold text-foreground">
                    5+
                  </div>
                  <div className="text-xs text-muted-foreground">接入渠道</div>
                </div>
                <div className="w-px h-8 bg-border" />
                <div>
                  <div className="text-xl lg:text-2xl font-bold text-foreground">
                    Docker
                  </div>
                  <div className="text-xs text-muted-foreground">安全隔离</div>
                </div>
                <div className="w-px h-8 bg-border" />
                <div>
                  <div className="text-xl lg:text-2xl font-bold text-foreground">
                    24/7
                  </div>
                  <div className="text-xs text-muted-foreground">自主运行</div>
                </div>
              </div>
            </div>

            {/* Right: Auth card — shown first on mobile */}
            <div className="flex justify-center lg:justify-end w-full">
              <div className="landing-glass-card w-full max-w-sm">
                {/* Logo */}
                <div className="flex justify-center mb-4 lg:mb-5">
                  <div className="w-12 h-12 lg:w-14 lg:h-14 rounded-2xl overflow-hidden shadow-lg">
                    <img
                      src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
                      alt="CKQClaw"
                      className="w-full h-full object-cover"
                    />
                  </div>
                </div>

                <h2 className="text-lg lg:text-xl font-semibold text-foreground text-center mb-1">
                  欢迎回来
                </h2>
                <p className="text-muted-foreground text-xs lg:text-sm text-center mb-5 lg:mb-6">
                  登录以继续使用 CKQClaw
                </p>

                {error && (
                  <div
                    role="alert"
                    className="mb-4 p-3 bg-error-bg border border-error/30 rounded-lg text-left"
                  >
                    <p className="text-sm text-error">{error}</p>
                  </div>
                )}

                {/* ── Login form ── */}
                <form onSubmit={handleLogin} className="text-left">
                  <div className="mb-3 lg:mb-4">
                    <Label htmlFor="login-username" className="mb-1.5 text-sm">
                      用户名
                    </Label>
                    <Input
                      id="login-username"
                      type="text"
                      value={loginUsername}
                      onChange={(e) => setLoginUsername(e.target.value)}
                      placeholder="请输入用户名"
                      required
                      autoFocus
                      className="h-9 bg-background/50"
                    />
                  </div>

                  <div className="mb-5 lg:mb-6">
                    <Label htmlFor="login-password" className="mb-1.5 text-sm">
                      密码
                    </Label>
                    <Input
                      id="login-password"
                      type="password"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      placeholder="请输入密码"
                      required
                      className="h-9 bg-background/50"
                    />
                  </div>

                  <Button
                    type="submit"
                    disabled={loading}
                    className="w-full h-9"
                  >
                    {loading && <Loader2 className="size-4 animate-spin" />}
                    {loading ? '登录中...' : '登录'}
                  </Button>
                </form>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
