import type { AccountQuotaWindow } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";

/** USD amounts remain independent from token/percentage quota windows. Absent is never zero. */
export function AccountBudgetTable({ limits }: { limits: AccountQuotaWindow[] }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const money = (value: number | undefined) => value === undefined
    ? zh ? "未知" : "Unknown"
    : new Intl.NumberFormat(resolvedLanguage, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value);
  const budgets = limits.filter(limit => limit.amount?.unit === "usd");
  if (!budgets.length) return null;
  return <section className="account-budgets" aria-label={zh ? "USD 费用预算" : "USD spend budgets"}>
    <h4>{zh ? "费用预算 · USD" : "Spend budgets · USD"}</h4>
    <div className="account-budget-table"><table>
      <thead><tr><th scope="col">{zh ? "作用域" : "Scope"}</th><th scope="col">{zh ? "已用" : "Spent"}</th><th scope="col">{zh ? "上限" : "Budget"}</th><th scope="col">{zh ? "剩余" : "Remaining"}</th></tr></thead>
      <tbody>{budgets.map(limit => <tr key={limit.id}>
        <th scope="row"><span>{limit.label}</span><small>{limit.scope?.windowId ?? ""}{limit.resetsAt === undefined ? "" : ` · ${new Date(limit.resetsAt).toLocaleString()}`}</small></th>
        <td className="mono">{money(limit.amount?.used)}</td><td className="mono">{money(limit.amount?.limit)}</td><td className="mono">{money(limit.amount?.remaining)}</td>
      </tr>)}</tbody>
    </table></div>
    <p className="small muted">{zh ? "Key 与 User 是同一调用账户的两条原生费用预算，不是 Token 数，也不是可兑换的重置券。未报告的金额保持未知。" : "Key and User are two native spend budgets for the calling account, not tokens or redeemable resets. Unreported amounts stay unknown."}</p>
  </section>;
}
