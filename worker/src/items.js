// ロープレで扱う品物を決め、その場の状態から「正解の買取額」を出す。
//
// 品物をAIに想像させると、型番も相場も毎回変わって採点の基準にならない。
// 実在の商品マスタから1点引き、状態はここで振り、正解額は計算で出す。
// AIに任せるのは「その状態をどう語るか」だけにする。

/**
 * 状態ランク。係数は「美品(A)を1.00とした相対値」。
 * 買取率そのものは商材ごとに違うため、商品マスタの retention 側に持たせている。
 */
export const CONDITIONS = [
  { id: 'S',  label: '新品同様',   ratio: 1.25, desc: '未使用または数回のみ使用。傷なし' },
  { id: 'A',  label: '美品',       ratio: 1.0,  desc: '使用感がほとんどない。目立つ傷なし' },
  { id: 'AB', label: '並品',       ratio: 0.78, desc: '通常使用の小傷・薄い汚れがある' },
  { id: 'B',  label: '使用感あり', ratio: 0.55, desc: '目立つ傷・角スレ・変色などがある' },
  { id: 'C',  label: '難あり',     ratio: 0.3,  desc: '大きな損傷・欠品・要修理' },
];

/** 付属品の有無。箱・保証書・ギャランティカードの有無で実際に額が動く */
export const ACCESSORIES = [
  { id: 'full',    label: '付属品完備', ratio: 1.1,  desc: '箱・保証書・付属品がすべて揃っている' },
  { id: 'partial', label: '一部あり',   ratio: 1.0,  desc: '箱か保証書のどちらかだけある' },
  { id: 'none',    label: '本体のみ',   ratio: 0.85, desc: '本体だけ。箱も保証書もない' },
];

/** 客の来歴。査定額そのものは動かさないが、客の語り口と手放しにくさを変える */
export const HISTORIES = [
  '10年ほど前に自分で買った。ずっと使っていたが最近は出番がない',
  '3年前に購入。思ったより使わなかった',
  '親から譲り受けたもの。自分では使わない',
  '結婚のお祝いにもらった。事情があって手放したい',
  '海外旅行先で買った。並行輸入品だと思う',
  '去年買ったばかりだが、別のものが欲しくなった',
  '遺品の整理で出てきた。価値が分からない',
  'ネットオークションで安く手に入れた。掘り出し物だと思っている',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** 万円未満を丸める。査定額は端数を出さないため */
const roundPrice = (v) => {
  if (v >= 1000000) return Math.round(v / 50000) * 50000;
  if (v >= 100000) return Math.round(v / 10000) * 10000;
  if (v >= 10000) return Math.round(v / 1000) * 1000;
  return Math.max(500, Math.round(v / 500) * 500);
};

/**
 * 品物 × 状態 → その回の正解額。
 * 正解は1点ではなく幅で持つ。現場でも「この辺なら妥当」の幅があるため。
 */
export function priceFor(product, condition, accessory) {
  const base = (Number(product.new_price) || 0) * ((Number(product.retention) || 30) / 100);
  const fair = base * condition.ratio * accessory.ratio;
  return {
    fair: roundPrice(fair),
    low: roundPrice(fair * 0.88),
    high: roundPrice(fair * 1.12),
  };
}

/** 実施1回分の品物を組み立てる。ここで決めたものは run に固定して保存する */
export function drawItem(product) {
  const condition = pick(CONDITIONS);
  const accessory = pick(ACCESSORIES);
  const price = priceFor(product, condition, accessory);
  return {
    product_id: product.id,
    category: product.category,
    brand: product.brand,
    model: product.model,
    name: product.name,
    notes: product.notes || '',
    new_price: Number(product.new_price) || 0,
    condition: condition.id,
    condition_label: condition.label,
    condition_desc: condition.desc,
    accessory: accessory.id,
    accessory_label: accessory.label,
    accessory_desc: accessory.desc,
    history: pick(HISTORIES),
    ...price,
  };
}

/**
 * 提示額と正解の距離から減点を出す。
 *
 * 金額を出していない回は減点しない（0）。
 * 「見せに来ただけ」の客のように、その場で額を出さないほうが正しい場面があり、
 * 出さなかったこと自体を罰すると型と矛盾するため。
 */
export const PRICE_PENALTY = { max: 20 };

export function pricePenalty(item, offered) {
  const value = Number(offered);
  if (!item || !Number.isFinite(value) || value <= 0) {
    return { penalty: 0, verdict: 'none', message: '金額の提示がなかったため、査定額では減点していません' };
  }
  if (value >= item.low && value <= item.high) {
    return { penalty: 0, verdict: 'fair', message: `適正（${yen(item.low)}〜${yen(item.high)}）の範囲内です` };
  }
  const gap = Math.abs(value - item.fair) / (item.fair || 1);
  const penalty = gap <= 0.2 ? 6 : gap <= 0.35 ? 12 : PRICE_PENALTY.max;
  const side = value < item.fair ? '安すぎます' : '高すぎます';
  return {
    penalty,
    verdict: value < item.fair ? 'low' : 'high',
    message: `提示 ${yen(value)} は適正 ${yen(item.fair)}（${yen(item.low)}〜${yen(item.high)}）より${side}`,
  };
}

export const yen = (v) => `${Math.round(Number(v) || 0).toLocaleString('ja-JP')}円`;
