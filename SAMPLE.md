# Markdown Reader サンプル

この拡張機能は **GitHub 風のスタイル**で Markdown を描画します。`inline code` やリンク（[GitHub](https://github.com)）にも対応。

> 引用ブロックもきれいに表示されます。

## 機能一覧

1. GFM テーブル / タスクリスト
2. シンタックスハイライト
3. 自動生成される目次

- [x] ローカルファイル対応
- [ ] Mermaid 図（今後の課題）

### コード

```js
export function greet(name) {
  return `こんにちは、${name}さん`;
}
```

```python
def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)
```

### テーブル

| 項目 | 説明 | 既定値 |
| --- | --- | ---: |
| テーマ | ライト/ダーク/自動 | 自動 |
| 目次 | サイドバー表示 | オン |
| 最大幅 | 本文の横幅 | 980px |

## セキュリティ

DOMPurify による無害化を行うため、`<script>` は実行されません。

### 補足

すべての処理はローカルで完結し、外部通信は行いません。
