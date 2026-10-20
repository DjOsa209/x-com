import { Button } from "./ui";
export function PageNavigation({
  page,
  total,
  pageSize,
  onChange,
}: {
  page: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="page-navigation">
      <span>
        共 {total} 条 · 第 {page} / {pages} 页
      </span>
      <div className="inline-actions">
        <Button disabled={page <= 1} onClick={() => onChange(page - 1)}>
          上一页
        </Button>
        <Button disabled={page >= pages} onClick={() => onChange(page + 1)}>
          下一页
        </Button>
      </div>
    </div>
  );
}
