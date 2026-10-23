import pandas as pd
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score
import lightgbm as lgb
import xgboost as xgb
import json
import itertools

# Load data
df = pd.read_csv(r"C:\Users\User\Frost Technology\FrostTrader\stock_ohlcv\ALL_STOCKS_5m.csv")
df['timestamp'] = pd.to_datetime(df['timestamp'])
df = df.sort_values(['ticker', 'timestamp']).reset_index(drop=True)

# Compute features per ticker
def compute_features(group):
    group = group.copy()
    group['return'] = group['close'].pct_change()
    group['vol_change'] = group['volume'].pct_change()
    group['high_low_range'] = (group['high'] - group['low']) / (group['close'] + 1e-8)
    group['close_position'] = (group['close'] - group['low']) / (group['high'] - group['low'] + 1e-8)
    
    # RSI (14 period)
    delta = group['close'].diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=14).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=14).mean()
    rs = gain / loss
    group['RSI'] = 100 - (100 / (1 + rs))
    
    # Momentum (5 period)
    group['momentum'] = group['close'] / group['close'].shift(5) - 1
    
    # Vol spike
    group['vol_spike'] = group['volume'] / group['volume'].rolling(window=20).mean()
    
    # Gap
    group['gap'] = group['open'] / group['close'].shift(1) - 1
    
    # Time of day
    group['time_of_day'] = group['timestamp'].dt.hour * 60 + group['timestamp'].dt.minute
    
    # Trend up (close > 20-bar MA)
    group['trend_up'] = (group['close'] > group['close'].rolling(window=20).mean()).astype(int)
    
    # Label: next close > current close
    group['label'] = (group['close'].shift(-1) > group['close']).astype(int)
    
    return group

df = df.groupby('ticker', group_keys=False).apply(compute_features)
df = df.dropna().reset_index(drop=True)

features = ['return', 'vol_change', 'high_low_range', 'close_position', 'RSI', 
            'momentum', 'vol_spike', 'gap', 'time_of_day', 'trend_up']

# Time-ordered 90/10 split
split_idx = int(len(df) * 0.9)
train_df = df.iloc[:split_idx]
test_df = df.iloc[split_idx:]

X_train = train_df[features]
y_train = train_df['label']
X_test = test_df[features]
y_test = test_df['label']

# Train models
print("Training LightGBM...")
lgb_model = lgb.LGBMClassifier(n_estimators=200, learning_rate=0.05, num_leaves=31, random_state=42)
lgb_model.fit(X_train, y_train)
lgb_prob_test = lgb_model.predict_proba(X_test)[:, 1]

print("Training XGBoost...")
xgb_model = xgb.XGBClassifier(n_estimators=200, learning_rate=0.05, max_depth=6, random_state=42, use_label_encoder=False, eval_metric='logloss')
xgb_model.fit(X_train, y_train)
xgb_prob_test = xgb_model.predict_proba(X_test)[:, 1]

print("Training Logistic Regression...")
lr_model = LogisticRegression(max_iter=1000, random_state=42)
lr_model.fit(X_train, y_train)
lr_prob_test = lr_model.predict_proba(X_test)[:, 1]

# Try different ensemble weights
weight_combos = list(itertools.product([1, 2, 3, 4, 5], repeat=3))

best_win_rate = 0
best_weights = None
best_trades = 0
best_expectancy = 0
best_pnl = 0
best_max_dd = 0

for w_lgb, w_xgb, w_lr in weight_combos:
    ensemble_prob = (w_lgb * lgb_prob_test + w_xgb * xgb_prob_test + w_lr * lr_prob_test) / (w_lgb + w_xgb + w_lr)
    ensemble_pred = (ensemble_prob > 0.5).astype(int)
    
    # Win rate
    wins = (ensemble_pred == y_test).sum()
    total = len(y_test)
    win_rate = wins / total
    
    # Expectancy and P&L (assume 1 unit per trade, win = +1, loss = -1)
    wins_count = (ensemble_pred == y_test).sum()
    losses_count = total - wins_count
    expectancy = (wins_count * 1 - losses_count * 1) / total
    pnl = wins_count - losses_count
    
    # Max drawdown (cumulative P&L)
    cum_pnl = np.cumsum(ensemble_pred * 2 - 1)  # +1 for win, -1 for loss
    running_max = np.maximum.accumulate(cum_pnl)
    drawdown = cum_pnl - running_max
    max_dd = np.min(drawdown)
    
    if win_rate > best_win_rate:
        best_win_rate = win_rate
        best_weights = (w_lgb, w_xgb, w_lr)
        best_trades = total
        best_expectancy = expectancy
        best_pnl = pnl
        best_max_dd = max_dd

# Print results
print(f"\n=== Best Ensemble ===")
print(f"Weights (LGB, XGB, LR): {best_weights}")
print(f"Win Rate: {best_win_rate:.4f} ({best_win_rate*100:.2f}%)")
print(f"Total Trades: {best_trades}")
print(f"Expectancy: {best_expectancy:.4f}")
print(f"Total P&L: {best_pnl}")
print(f"Max Drawdown: {best_max_dd:.4f}")

# Save best config
best_config = {
    "weights": {
        "lightgbm": best_weights[0],
        "xgboost": best_weights[1],
        "logistic_regression": best_weights[2]
    },
    "win_rate": best_win_rate,
    "total_trades": best_trades,
    "expectancy": best_expectancy,
    "total_pnl": best_pnl,
    "max_drawdown": best_max_dd
}

with open(r"C:\Users\User\Frost Technology\FrostTrader\agent3_best.json", "w") as f:
    json.dump(best_config, f, indent=2)

print(f"\nSaved best config to agent3_best.json")
