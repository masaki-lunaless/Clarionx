-- 開始前にシチュエーションを変えられるようにする。
-- モードの既定を、その回かぎり上書きする。採点は上書き後の客タイプで行うため、
-- モードを見に行くだけでは足りず、回そのものに持たせる必要がある。
ALTER TABLE runs ADD COLUMN customer_type TEXT;
ALTER TABLE runs ADD COLUMN scenario TEXT;
ALTER TABLE runs ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'normal';
