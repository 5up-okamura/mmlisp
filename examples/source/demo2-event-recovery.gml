; GMLisp demo 2
; Purpose: intervention and recovery behavior (base + delta)
; Structure: intro(2bar) + stress-loop(1bar x4) + recovery(2bar) = 8-bar loop in A minor

(score :id :demo2-event-recovery
  :title "Demo 2 Event Recovery"
  :author "okamura"
  :tempo 132

  (track :tense
    :loop true
    :role :bgm
    :ch [:fm1 :fm2]

    (phrase :bed
      :len 1/8

      (marker :calm)
      (param-set :fm-tl1 40)
      (param-set :tempo-scale 0)

      (notes :a3 :c4 :e4 :c4 :a3 :c4 :e4 :c4)

      (notes :g3 :b3 :d4 :b3 :g3 _ :g3 _)

      (loop-begin :stress)
      (param-add :fm-tl1 -3)
      (param-add :tempo-scale +2)
      (notes :e4 :g4 :a4 :g4 :e4 :c4 :b3 :a3)
      (loop-end :stress 4)

      (marker :recover)
      (param-set :fm-tl1 40)
      (param-set :tempo-scale 0)

      (notes :a3 :c4 :e4 :c4 :a3 _ _ _)

      (note :a3 1/2)
      (rest 1/4)
      (note :a3 1/4)

      (jump :calm)
    )
  )
)
