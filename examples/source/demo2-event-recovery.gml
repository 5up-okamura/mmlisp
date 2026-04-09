; GMLisp demo skeleton 2
; Purpose: intervention and recovery behavior (base + delta)

(score :id :demo2-event-recovery
  :title "Demo 2 Event Recovery"
  :author "okamura"

  (part :tense
    :loop true
    :ch [:fm1 :fm2]

    (phrase :bed
      :tempo 132
      :len 1/16

      (note :a3)
      (tie 1/16)
      (rest 1/16)
      (note :c4)

      (param-set :fm-tl1 40)
      (param-add :fm-tl1 -3)
      (param-add :tempo-scale +4)

      (loop-begin :l1)
      (note :e4)
      (note :d4)
      (loop-end :l1 2))))
