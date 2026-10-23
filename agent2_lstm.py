import pandas as pd
import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
import warnings
warnings.filterwarnings('ignore')

# Load data
print("Loading data...")
df = pd.read_csv(r"C:\Users\User\Frost Technology\FrostTrader\stock_ohlcv\ALL_STOCKS_5m.csv")
df['timestamp'] = pd.to_datetime(df['timestamp'])
df = df.sort_values(['ticker', 'timestamp']).reset_index(drop=True)

# Compute features per ticker
print("Computing features...")
FEATURES = []
for ticker in df['ticker'].unique():
    tdf = df[df['ticker'] == ticker].copy()
    
    # return
    tdf['return'] = tdf['close'].pct_change()
    # vol_change
    tdf['vol_change'] = tdf['volume'].pct_change()
    # high_low_range
    tdf['high_low_range'] = (tdf['high'] - tdf['low']) / tdf['close']
    # close_position
    tdf['close_position'] = (tdf['close'] - tdf['low']) / (tdf['high'] - tdf['low'] + 1e-8)
    # RSI 14
    delta = tdf['close'].diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=14, min_periods=1).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=14, min_periods=1).mean()
    rs = gain / (loss + 1e-8)
    tdf['rsi'] = 100 - (100 / (1 + rs))
    # momentum
    tdf['momentum'] = tdf['close'] - tdf['close'].shift(5)
    # vol_spike
    tdf['vol_spike'] = tdf['volume'] / tdf['volume'].rolling(20).mean()
    # gap
    tdf['gap'] = tdf['open'] / tdf['close'].shift(1) - 1
    # time_of_day
    tdf['time_of_day'] = (tdf['timestamp'].dt.hour * 60 + tdf['timestamp'].dt.minute) / 1440.0
    # target
    tdf['target'] = (tdf['close'] > tdf['close'].shift(1)).astype(int)
    
    # Drop NaN rows
    tdf = tdf.dropna().reset_index(drop=True)
    FEATURES.append(tdf)

feat_df = pd.concat(FEATURES, ignore_index=True)

feature_cols = ['return', 'vol_change', 'high_low_range', 'close_position', 
                'rsi', 'momentum', 'vol_spike', 'gap', 'time_of_day']

# Build sequences of 20 bars
print("Building sequences...")
SEQ_LEN = 20
X_all = []
y_all = []
close_all = []  # close price at position i (the last bar of the sequence)
ticker_all = []

for ticker, group in feat_df.groupby('ticker'):
    feats = group[feature_cols].values
    targets = group['target'].values
    closes = group['close'].values
    n = len(group)
    
    for i in range(SEQ_LEN, n):
        seq = feats[i - SEQ_LEN:i]
        X_all.append(seq)
        y_all.append(targets[i])
        close_all.append(closes[i])
        ticker_all.append(ticker)

X_all = np.array(X_all, dtype=np.float32)
y_all = np.array(y_all, dtype=np.float32)
close_all = np.array(close_all, dtype=np.float32)

print(f"Total sequences: {len(X_all)}")
print(f"Sequence shape: {X_all[0].shape}")

# Time-ordered split: first 90% train, last 10% validate
split = int(0.9 * len(X_all))
X_train, X_val = X_all[:split], X_all[split:]
y_train, y_val = y_all[:split], y_all[split:]
close_train, close_val = close_all[:split], close_all[split:]
ticker_train, ticker_val = ticker_all[:split], ticker_all[split:]

print(f"Train: {len(X_train)}, Validate: {len(X_val)}")

# Dataset class
class StockDataset(Dataset):
    def __init__(self, X, y, closes):
        self.X = X
        self.y = y
        self.closes = closes
    
    def __len__(self):
        return len(self.X)
    
    def __getitem__(self, idx):
        return self.X[idx], self.y[idx], self.closes[idx]

train_ds = StockDataset(X_train, y_train, close_train)
val_ds = StockDataset(X_val, y_val, close_val)
train_loader = DataLoader(train_ds, batch_size=256, shuffle=False)
val_loader = DataLoader(val_ds, batch_size=256, shuffle=False)

# LSTM model
class LSTMStock(nn.Module):
    def __init__(self, input_size, hidden_size):
        super(LSTMStock, self).__init__()
        self.lstm = nn.LSTM(input_size, hidden_size, batch_first=True)
        self.fc = nn.Linear(hidden_size, 1)
    
    def forward(self, x):
        # x: (batch, seq_len, features)
        lstm_out, _ = self.lstm(x)
        # Take last time step
        last = lstm_out[:, -1, :]
        out = self.fc(last)
        return out.squeeze(-1)

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print(f"Using device: {device}")

results = {}
best_model = None
best_metric = -float('inf')

for hidden in [64, 128, 256]:
    print(f"\n{'='*50}")
    print(f"Training with hidden_size={hidden}")
    print(f"{'='*50}")
    
    model = LSTMStock(9, hidden).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
    criterion = nn.BCEWithLogitsLoss()
    
    # Train for 10 epochs
    for epoch in range(10):
        model.train()
        total_loss = 0
        for X_batch, y_batch, _ in train_loader:
            X_batch = X_batch.to(device)
            y_batch = y_batch.to(device)
            
            optimizer.zero_grad()
            pred = model(X_batch)
            loss = criterion(pred, y_batch)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        
        avg_loss = total_loss / len(train_loader)
        print(f"  Epoch {epoch+1}/10, Loss: {avg_loss:.4f}")
    
    # Backtest on validation
    model.eval()
    predictions = []
    val_closes = []
    
    with torch.no_grad():
        for X_batch, y_batch, close_batch in val_loader:
            X_batch = X_batch.to(device)
            pred = model(X_batch)
            pred_prob = torch.sigmoid(pred)
            predictions.extend(pred_prob.cpu().numpy())
            val_closes.extend(close_batch.numpy())
    
    predictions = np.array(predictions)
    val_closes = np.array(val_closes)
    
    # Long when sigmoid > 0.5
    long_positions = predictions > 0.5
    
    # P&L = close[i+1]/close[i] - 1 if long else 0
    # close[i] is the close at position i (last bar of sequence)
    # close[i+1] is the next bar's close
    # We need to compute P&L using the actual close prices
    # P&L[i] = close[i+1]/close[i] - 1 if long at position i else 0
    # But we only have close[i] (the close at the last bar of the sequence)
    # We need close[i+1] which is the next bar's close
    
    # Actually, let me think about this more carefully.
    # The target is: 1 if close[i] > close[i-1] else 0
    # So the model predicts whether the close goes up from bar i-1 to bar i.
    # In the backtest, at position i, we have the prediction based on bars [i-19, i-1] (20 bars)
    # Wait, let me re-read the sequence building.
    
    # seq = feats[i - SEQ_LEN:i], so the sequence covers bars i-20 to i-1
    # target = targets[i] which is 1 if close[i] > close[i-1]
    # close_all[i] = closes[i] which is the close at bar i
    
    # So in the backtest, at position i:
    # - We have the sequence of 20 bars ending at bar i-1
    # - The model predicts whether close[i] > close[i-1]
    # - close_all[i] is the close at bar i
    
    # For P&L, if we go long at bar i (based on the prediction), 
    # we buy at close[i] and sell at close[i+1]
    # P&L = close[i+1]/close[i] - 1
    
    # But we need close[i+1]. The close array has close[i] for each position i.
    # So close[i+1] is the next element in the close array.
    
    # Let me re-think. The close array is indexed by position in the sequence.
    # close[i] is the close price at bar i (the target bar).
    # If we go long at bar i, we buy at close[i] and sell at close[i+1].
    # close[i+1] is the close at bar i+1, which is the next element in the close array.
    
    # But wait, the last position in the sequence doesn't have a next bar.
    # So we can only compute P&L for positions 0 to len-2.
    
    # Actually, let me re-read the problem.
    # "Backtest on validation: long when sigmoid(output) > 0.5, P&L = close[i+1]/close[i] - 1 if long else 0."
    # So P&L[i] = close[i+1]/close[i] - 1 if long at position i else 0.
    # close[i] is the close at position i (the target bar).
    # close[i+1] is the close at position i+1 (the next bar).
    
    # So we need to compute P&L for each position i using close[i] and close[i+1].
    # The last position doesn't have a close[i+1], so we skip it.
    
    n_val = len(val_closes)
    pnl = np.zeros(n_val)
    
    for i in range(n_val - 1):
        if long_positions[i]:
            pnl[i] = val_closes[i+1] / val_closes[i] - 1
    
    # Win rate: fraction of long positions that made a profit
    long_idx = np.where(long_positions)[0]
    # Only consider positions where we have a next bar
    long_idx = long_idx[long_idx < n_val - 1]
    
    if len(long_idx) > 0:
        wins = (pnl[long_idx] > 0).sum()
        win_rate = wins / len(long_idx)
        total_trades = len(long_idx)
        expectancy = pnl[long_idx].mean()
        total_pnl = pnl[long_idx].sum()
    else:
        win_rate = 0
        total_trades = 0
        expectancy = 0
        total_pnl = 0
    
    # Max drawdown: track cumulative P&L and find the max drop
    cum_pnl = np.cumsum(pnl[long_idx]) if len(long_idx) > 0 else np.array([0])
    running_max = np.maximum.accumulate(cum_pnl)
    drawdown = running_max - cum_pnl
    max_dd = drawdown.max() if len(drawdown) > 0 else 0
    
    print(f"\nResults for hidden_size={hidden}:")
    print(f"  Win rate: {win_rate:.4f}")
    print(f"  Total trades: {total_trades}")
    print(f"  Expectancy: {expectancy:.6f}")
    print(f"  Total P&L: {total_pnl:.6f}")
    print(f"  Max drawdown: {max_dd:.6f}")
    
    results[hidden] = {
        'win_rate': win_rate,
        'total_trades': total_trades,
        'expectancy': expectancy,
        'total_pnl': total_pnl,
        'max_dd': max_dd
    }
    
    # Track best model (by total P&L)
    if total_pnl > best_metric:
        best_metric = total_pnl
        best_model = model
        best_hidden = hidden

# Save best model
if best_model is not None:
    torch.save(best_model.state_dict(), r"C:\Users\User\Frost Technology\FrostTrader\agent2_best.pt")
    print(f"\nBest model saved with hidden_size={best_hidden}, total P&L={best_metric:.6f}")
else:
    print("\nNo model to save.")

print("\nDone.")
