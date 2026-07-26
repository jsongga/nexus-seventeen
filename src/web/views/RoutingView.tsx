import { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  BadgeDollarSign,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleGauge,
  DatabaseZap,
  Gauge,
  Eye,
  FileText,
  Layers3,
  LockKeyhole,
  Radio,
  RefreshCcw,
  Route,
  ShieldCheck,
  ShieldAlert,
  TestTube2,
  TrendingDown,
  Zap,
} from 'lucide-react';
import type { RiskTone } from '../data/demo';
import { routeModel } from '../domain';
import { Button, Card, cn, FieldLabel, inputClass, Pill, ProgressBar } from '../components/ui';

type SimRole = 'manager' | 'engineer' | 'verifier';

interface SimDecision {
  tier: 'Economy' | 'Balanced' | 'Frontier';
  model: string;
  provider: 'OpenAI' | 'Anthropic';
  reason: string;
  estimate: string;
  color: 'teal' | 'neutral' | 'amber';
}

const tiers = [
  {
    name: 'Economy',
    share: '72% of calls',
    description: 'Routine scoping, bounded engineer loops, test repair, summaries, and progress-journal updates.',
    models: ['GPT-5.4 mini', 'Claude Haiku 4.5'],
    tone: 'green' as const,
    icon: Zap,
  },
  {
    name: 'Balanced',
    share: '24% of calls',
    description: 'Ambiguous multi-file work, substantive review, security-sensitive or high-risk changes.',
    models: ['GPT-5.6 Terra', 'Claude Sonnet 5'],
    tone: 'neutral' as const,
    icon: BrainCircuit,
  },
  {
    name: 'Frontier',
    share: '4% ceiling',
    description: 'Critical work, repeated failed verification, manager disagreement, or explicit human choice.',
    models: ['GPT-5.6 Sol', 'Claude Fable 5'],
    tone: 'amber' as const,
    icon: ShieldAlert,
  },
];

export function RoutingView() {
  const [role, setRole] = useState<SimRole>('engineer');
  const [risk, setRisk] = useState<RiskTone>('medium');
  const [failures, setFailures] = useState(0);
  const [securitySensitive, setSecuritySensitive] = useState(false);
  const [largeDiff, setLargeDiff] = useState(false);

  const decision = useMemo<SimDecision>(() => {
    const routed = routeModel({
      role,
      risk,
      evidence: {
        failedAttempts: failures,
        securitySensitive,
        largeDiff,
      },
    });
    const tier = `${routed.tier[0].toUpperCase()}${routed.tier.slice(1)}` as SimDecision['tier'];
    const estimates = {
      economy: '$0.08–$0.70',
      balanced: '$0.90–$2.80',
      frontier: '$3.80–$8.20',
    };
    const colors = {
      economy: 'teal' as const,
      balanced: 'neutral' as const,
      frontier: 'amber' as const,
    };

    return {
      tier,
      model: routed.model.displayName,
      provider: routed.provider === 'openai' ? 'OpenAI' : 'Anthropic',
      reason: routed.reasons.join(' '),
      estimate: estimates[routed.tier],
      color: colors[routed.tier],
    };
  }, [role, risk, failures, securitySensitive, largeDiff]);

  return (
    <div className="space-y-7">
      <header>
        <div className="flex items-center gap-2 text-sm font-semibold text-teal-700">
          <ShieldCheck size={16} />
          <span>Cheap-first policy active</span>
          <span className="font-mono text-[11px] font-medium text-muted">Policy v3.2</span>
        </div>
        <h1 className="mt-3 font-display text-[28px] font-light leading-tight tracking-[-0.035em] text-ink sm:text-[36px]">
          Spend less by proving more.
        </h1>
        <p className="mt-2 max-w-3xl text-[14px] leading-6 text-muted sm:text-[15px]">
          Small Codex and Claude models do bounded work by default. Tests, fresh-context review, and risk signals—not model prestige—decide when Fable or Sol is worth the cost.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Card className="p-4 sm:p-5">
          <TrendingDown size={17} className="text-teal-700" />
          <p className="mt-3 font-mono text-[27px] font-semibold tracking-[-0.045em] text-ink">68%</p>
          <p className="mt-1 text-[11px] font-bold text-muted">Projected cost reduction</p>
          <p className="mt-1 text-[10px] text-muted">vs. frontier-only estimate</p>
        </Card>
        <Card className="p-4 sm:p-5">
          <DatabaseZap size={17} className="text-teal-700" />
          <p className="mt-3 font-mono text-[27px] font-semibold tracking-[-0.045em] text-ink">61%</p>
          <p className="mt-1 text-[11px] font-bold text-muted">Cached input share</p>
          <p className="mt-1 text-[10px] text-muted">stable instructions reused</p>
        </Card>
        <Card className="p-4 sm:p-5">
          <Layers3 size={17} className="text-teal-700" />
          <p className="mt-3 font-mono text-[27px] font-semibold tracking-[-0.045em] text-ink">−73%</p>
          <p className="mt-1 text-[11px] font-bold text-muted">Context carried forward</p>
          <p className="mt-1 text-[10px] text-muted">delta packets, not transcripts</p>
        </Card>
        <Card className="p-4 sm:p-5">
          <CircleGauge size={17} className="text-caution" />
          <p className="mt-3 font-mono text-[27px] font-semibold tracking-[-0.045em] text-ink">0 / 12</p>
          <p className="mt-1 text-[11px] font-bold text-muted">Frontier calls this week</p>
          <p className="mt-1 text-[10px] text-muted">no quality gate required one</p>
        </Card>
      </section>

      <Card className="overflow-hidden border-teal-border bg-white">
        <div className="grid lg:grid-cols-[minmax(240px,.72fr)_minmax(0,1.28fr)]">
          <div className="border-b border-teal-border bg-teal-soft p-5 sm:p-6 lg:border-b-0 lg:border-r">
            <div className="flex flex-wrap items-center gap-2">
              <span className="grid size-10 place-items-center rounded-xl bg-teal-500 text-ink">
                <Eye size={18} />
              </span>
              <Pill tone="green">Economy only</Pill>
            </div>
            <h2 className="mt-4 font-display text-[18px] font-semibold tracking-[-0.025em] text-ink">Impact observer</h2>
            <p className="mt-1.5 text-[12px] leading-5 text-muted">
              A weak, low-cost model turns new agent progress into a short explanation of what the work changes for users.
            </p>
          </div>

          <div className="p-5 sm:p-6">
            <div className="grid gap-2.5 sm:grid-cols-2">
              {[
                {
                  icon: Radio,
                  label: 'Runs on new progress',
                  detail: 'Refreshes only after an agent writes a progress update.',
                },
                {
                  icon: Layers3,
                  label: 'Bounded input',
                  detail: 'Reads a compact progress-event packet, never the full transcript.',
                },
                {
                  icon: FileText,
                  label: 'Tiny output budget',
                  detail: 'Writes one high-level, result-oriented overview in plain language.',
                },
                {
                  icon: LockKeyhole,
                  label: 'No tools or authority',
                  detail: 'Cannot direct agents, change work, approve, or deploy anything.',
                },
              ].map(({ icon: Icon, label, detail }) => (
                <div key={label} className="flex items-start gap-3 rounded-xl border border-line bg-white p-3.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-teal-soft text-teal-700">
                    <Icon size={14} />
                  </span>
                  <div>
                    <p className="text-[11px] font-bold text-muted">{label}</p>
                    <p className="mt-1 text-[10px] leading-4 text-muted">{detail}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-caution-border bg-caution-soft px-3.5 py-3">
              <ShieldCheck size={14} className="mt-0.5 shrink-0 text-caution" />
              <p className="text-[10px] leading-4 text-caution">
                Interpretation only. The observer is never used as quality, review, approval, or release evidence.
              </p>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(360px,.95fr)]">
        <section className="space-y-3">
          <div>
            <h2 className="font-display text-[17px] font-semibold tracking-[-0.02em] text-ink">Routing ladder</h2>
            <p className="mt-0.5 text-sm text-muted">Move up only when evidence says the cheaper tier is insufficient.</p>
          </div>
          <div className="space-y-3">
            {tiers.map((tier, index) => {
              const Icon = tier.icon;
              const toneClasses = {
                green: 'bg-teal-soft text-teal-700',
                neutral: 'bg-muted-surface text-muted',
                amber: 'bg-caution-soft text-caution',
              };
              return (
                <div key={tier.name} className="relative">
                  <Card className="p-4 sm:p-5">
                    <div className="flex items-start gap-4">
                      <span className={cn('grid size-11 shrink-0 place-items-center rounded-2xl', toneClasses[tier.tone])}>
                        <Icon size={19} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-display text-[15px] font-semibold text-ink">{tier.name}</h3>
                          <Pill tone={tier.tone}>{tier.share}</Pill>
                        </div>
                        <p className="mt-1.5 text-[12px] leading-5 text-muted">{tier.description}</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {tier.models.map((model) => (
                            <span
                              key={model}
                              className="rounded-lg border border-line bg-card px-2.5 py-1 text-[10px] font-bold text-muted"
                            >
                              {model}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </Card>
                  {index < tiers.length - 1 ? (
                    <span className="absolute -bottom-3.5 left-[2.35rem] z-10 grid size-7 place-items-center rounded-full border border-line bg-paper text-muted">
                      <ArrowDown size={13} />
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <Card className="self-start overflow-hidden">
          <div className="border-b border-line bg-card px-5 py-4 sm:px-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-[17px] font-semibold tracking-[-0.02em] text-ink">Route simulator</h2>
                <p className="mt-0.5 text-[11px] text-muted">Preview policy before a run spends tokens.</p>
              </div>
              <span className="grid size-10 place-items-center rounded-xl bg-teal-soft text-teal-700">
                <Route size={18} />
              </span>
            </div>
          </div>

          <div className="space-y-4 p-5 sm:p-6">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel htmlFor="sim-role">Role</FieldLabel>
                <select
                  id="sim-role"
                  className={inputClass}
                  value={role}
                  onChange={(event) => setRole(event.target.value as SimRole)}
                >
                  <option value="manager">Engineering manager</option>
                  <option value="engineer">Software engineer</option>
                  <option value="verifier">Verification engineer</option>
                </select>
              </div>
              <div>
                <FieldLabel htmlFor="sim-risk">Risk</FieldLabel>
                <select
                  id="sim-risk"
                  className={inputClass}
                  value={risk}
                  onChange={(event) => setRisk(event.target.value as RiskTone)}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label htmlFor="sim-failures" className="text-xs font-bold text-muted">
                  Failed verification attempts
                </label>
                <Pill tone={failures >= 2 ? 'red' : failures === 1 ? 'amber' : 'green'}>{failures}</Pill>
              </div>
              <input
                id="sim-failures"
                type="range"
                min="0"
                max="3"
                value={failures}
                onChange={(event) => setFailures(Number(event.target.value))}
                className="w-full accent-teal-700"
              />
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line bg-card px-3 text-[11px] font-bold text-muted">
                <input
                  type="checkbox"
                  checked={securitySensitive}
                  onChange={(event) => setSecuritySensitive(event.target.checked)}
                  className="size-4 accent-teal-700"
                />
                Security-sensitive
              </label>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line bg-card px-3 text-[11px] font-bold text-muted">
                <input
                  type="checkbox"
                  checked={largeDiff}
                  onChange={(event) => setLargeDiff(event.target.checked)}
                  className="size-4 accent-teal-700"
                />
                Large cross-file diff
              </label>
            </div>

            <div
              className={cn(
                'rounded-2xl border p-4',
                decision.color === 'teal'
                  ? 'border-teal-border bg-teal-soft'
                  : decision.color === 'neutral'
                    ? 'border-line bg-paper'
                    : 'border-caution-border bg-caution-soft',
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'grid size-8 place-items-center rounded-xl',
                      decision.color === 'teal'
                        ? 'bg-teal-500 text-ink'
                        : decision.color === 'neutral'
                          ? 'bg-muted-surface text-muted'
                          : 'bg-caution-fill text-ink',
                    )}
                  >
                    <BrainCircuit size={15} />
                  </span>
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.09em] text-muted">
                      {decision.tier} route
                    </p>
                    <p className="mt-0.5 text-sm font-bold text-ink">{decision.model}</p>
                  </div>
                </div>
                <Pill tone={decision.color === 'teal' ? 'green' : decision.color}>{decision.provider}</Pill>
              </div>
              <p className="mt-3 text-[11px] leading-5 text-muted">{decision.reason}</p>
              <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-[10px] font-bold text-muted">
                <span>Estimated run cost</span>
                <span className="font-mono">{decision.estimate}</span>
              </div>
            </div>

            <Button
              variant="quiet"
              size="sm"
              className="w-full"
              icon={<RefreshCcw size={14} />}
              onClick={() => {
                setRole('engineer');
                setRisk('medium');
                setFailures(0);
                setSecuritySensitive(false);
                setLargeDiff(false);
              }}
            >
              Reset scenario
            </Button>
          </div>
        </Card>
      </div>

      <section className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card className="p-5 sm:p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-[17px] font-semibold text-ink">Token envelope</h2>
              <p className="mt-0.5 text-[11px] text-muted">Projected across active missions</p>
            </div>
            <BadgeDollarSign size={19} className="text-teal-700" />
          </div>
          <div className="mt-5 space-y-4">
            <div>
              <div className="mb-2 flex justify-between text-[11px] font-bold text-muted">
                <span>Routed spend</span>
                <span className="font-mono">$11.77</span>
              </div>
              <ProgressBar value={32} tone="green" className="h-2.5" />
            </div>
            <div>
              <div className="mb-2 flex justify-between text-[11px] font-bold text-muted">
                <span>Frontier-only estimate</span>
                <span className="font-mono">$36.78</span>
              </div>
              <ProgressBar value={100} tone="amber" className="h-2.5" />
            </div>
          </div>
          <p className="mt-4 text-[10px] leading-4 text-muted">
            Projection uses current public token rates and demo token volumes; provider billing can differ by cache, tool, and subscription.
          </p>
        </Card>

        <Card className="p-5 sm:p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-[17px] font-semibold text-ink">Quality floor</h2>
              <p className="mt-0.5 text-[11px] text-muted">Routing earns trust through evidence</p>
            </div>
            <Gauge size={19} className="text-teal-700" />
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {[
              ['Deterministic checks first', TestTube2],
              ['Fresh-context manager', ShieldCheck],
              ['Two attempts, then escalate', ChevronRight],
              ['Hard budget stops', Check],
            ].map(([label, Icon]) => (
              <div key={label as string} className="flex items-center gap-2 rounded-xl bg-paper px-3 py-2.5">
                <Icon size={14} className="text-teal-700" />
                <span className="text-[10px] font-bold text-muted">{label as string}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-start gap-3 rounded-xl border border-caution-border bg-caution-soft p-3.5">
            <ArrowRight size={15} className="mt-0.5 shrink-0 text-caution" />
            <p className="text-[10px] leading-4 text-caution">
              Target: stay within two quality points of the always-Fable/Sol benchmark at 40% lower normalized cost. This MVP defines the gate; a representative eval suite must prove it.
            </p>
          </div>
        </Card>
      </section>
    </div>
  );
}
