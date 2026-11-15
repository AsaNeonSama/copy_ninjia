import type React from "react";
import { detectBrowserDefaultLanguage, getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { buildFallbackDiagnostics } from "../libs/diagnostics";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import type { MiniAppAccessDiagnostics, MiniAppLanguage } from "../types/miniApp";

/**
 * 渲染外部访问或鉴权失败时的平行四边形拦截诊断页（按浏览器默认语言展示请求链路节点、拦截原因与请求诊断信息，内层文案与徽章反向拉正保持水平可读）。
 *
 * @returns React 节点
 */
export function AccessDeniedPage(): React.JSX.Element {
  const deniedDiag: Readonly<MiniAppAccessDiagnostics> | null = useMiniAppStore(
    (state: MiniAppUiStoreState): Readonly<MiniAppAccessDiagnostics> | null =>
      state.deniedDiag
  );
  const deniedLang: MiniAppLanguage = detectBrowserDefaultLanguage();
  const dt: Readonly<MiniAppTranslations> =
    getMiniAppTranslations(deniedLang);
  const diag: Readonly<MiniAppAccessDiagnostics> =
    deniedDiag ?? buildFallbackDiagnostics(dt.gate.deniedDescription);
  return (
    <div className="cf-error-page">
      <div className="cf-error-container">
        <div className="cf-header">
          <div className="cf-title-row">
            <span className="cf-main-title">{dt.gate.deniedTitle}</span>
            <span className="cf-code-pill">
              <span>
                HTTP {diag.status} · {diag.code}
              </span>
            </span>
          </div>
          <p className="cf-subtitle">{dt.gate.deniedDescription}</p>
          <div className="cf-timestamp">{diag.timestamp}</div>
        </div>

        <div className="cf-status-band">
          <div className="cf-status-inner">
            <div className="cf-node">
              <div className="cf-node-content">
                <div className="cf-node-icon ok">
                  <span>✓</span>
                </div>
                <div className="cf-node-meta">
                  <div className="cf-node-sub">{dt.gate.deniedNodeClientSub}</div>
                  <div className="cf-node-title">
                    {dt.gate.deniedNodeClientTitle}
                  </div>
                  <div className="cf-node-state ok">
                    {dt.gate.deniedNodeClientState}
                  </div>
                </div>
              </div>
            </div>

            <div className="cf-node">
              <div className="cf-node-content">
                <div className="cf-node-icon err">
                  <span>✕</span>
                </div>
                <div className="cf-node-meta">
                  <div className="cf-node-sub">
                    {dt.gate.deniedNodeGatewaySub}
                  </div>
                  <div className="cf-node-title">
                    {dt.gate.deniedNodeGatewayTitle}
                  </div>
                  <div className="cf-node-state err">
                    {dt.gate.deniedNodeGatewayState(diag.status)}
                  </div>
                </div>
              </div>
            </div>

            <div className="cf-node">
              <div className="cf-node-content">
                <div className="cf-node-icon ok">
                  <span>✓</span>
                </div>
                <div className="cf-node-meta">
                  <div className="cf-node-sub">{dt.gate.deniedNodeOriginSub}</div>
                  <div className="cf-node-title">{diag.host}</div>
                  <div className="cf-node-state ok">
                    {dt.gate.deniedNodeOriginState}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="cf-details-grid">
          <div className="cf-detail-col">
            <h2>{dt.gate.deniedWhatHappenedTitle}</h2>
            <p>{dt.gate.deniedWhatHappenedDesc}</p>
            <div className="cf-reason-box">
              <div className="cf-reason-content">
                <strong>{dt.gate.deniedPolicyDetailLabel(diag.code)}:</strong>{" "}
                {dt.gate.deniedPolicyReason(diag.code, diag.error, diag)}
              </div>
            </div>
          </div>
          <div className="cf-detail-col">
            <h2>{dt.gate.deniedWhatCanIDoTitle}</h2>
            <p>{dt.gate.deniedWhatCanIDoDesc}</p>
          </div>
        </div>

        <div className="cf-footer">
          <span>
            Request ID:{" "}
            <strong>
              <span>{diag.requestId}</span>
            </strong>
          </span>
          <span className="cf-sep">•</span>
          <span>
            Client IP:{" "}
            <strong>
              <span>{diag.clientIp}</span>
            </strong>
          </span>
          <span className="cf-sep">•</span>
          <span>
            Host:{" "}
            <strong>
              <span>{diag.host}</span>
            </strong>
          </span>
          <span className="cf-sep">•</span>
          <span>
            Path:{" "}
            <strong>
              <span>{diag.path}</span>
            </strong>
          </span>
        </div>
      </div>
    </div>
  );
}
